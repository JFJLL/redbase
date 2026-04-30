const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { ROOT } = require("./config");
const {
  randomId,
  joinUrl,
  assertConfigured,
  clampScore,
  normalizeTags,
  sanitizeIdea,
  parseJsonFromModelText,
  withRetries,
  normalizeChineseCopy,
  pickVariant,
} = require("./utils");

const IMAGE_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_JOB_HTTP_TIMEOUT_MS = 5 * 60 * 1000;

function createAiServices(appConfig) {
  const imageJobs = new Map();

  return {
    imageJobs,
    generateAiTrendSet: (brand, baseId) => generateAiTrendSet(appConfig, brand, baseId),
    regenerateTrendIdeas: (brand, trend, customPrompt) => regenerateTrendIdeas(appConfig, brand, trend, customPrompt),
    createImageJob: ({ brand, trend, idea, metadata, productImage, productImages, logoImage, styleReferenceImages, sourceImageUrls, sourceImages, aspectRatio }) =>
      createImageJob(appConfig, imageJobs, {
        brand,
        trend,
        idea,
        metadata,
        productImage,
        productImages,
        logoImage,
        styleReferenceImages,
        sourceImageUrls,
        sourceImages,
        aspectRatio,
      }),
    resolveImageJob: (job) => resolveImageJob(appConfig, imageJobs, job),
    buildImageJobResponse,
    buildTextProviderEndpoint: () => buildTextProviderEndpoint(appConfig),
  };
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const timeoutMs = Number(options.timeoutMs || 180000);
    const request = transport.request(
      target,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            data = null;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = data?.error?.message || data?.error || data?.message || raw || `HTTP ${response.statusCode}`;
            const httpError = new Error(message);
            httpError.statusCode = response.statusCode;
            httpError.url = url;
            httpError.rawBody = raw;
            httpError.payload = data;
            reject(httpError);
            return;
          }

          resolve(data);
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout: ${url}`));
    });

    request.on("error", reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function fetchJsonViaPython(url, options = {}) {
  return new Promise((resolve, reject) => {
    const script = [
      "import base64, json, sys, requests",
      "sys.stdout.reconfigure(encoding='utf-8')",
      "try:",
      "    payload = json.loads(base64.b64decode(sys.stdin.read()).decode('utf-8'))",
      "    session = requests.Session()",
      "    session.trust_env = False",
      "    body = payload.get('body')",
      "    if isinstance(body, str):",
      "        body = body.encode('utf-8')",
      "    response = session.request(",
      "        method=payload.get('method', 'GET'),",
      "        url=payload['url'],",
      "        headers=payload.get('headers') or {},",
      "        data=body,",
      "        timeout=payload.get('timeout', 60),",
      "    )",
      "    print(json.dumps({'ok': True, 'status': response.status_code, 'text': response.text}, ensure_ascii=False))",
      "except Exception as exc:",
      "    print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))",
    ].join("\n");

    const child = spawn("python", ["-X", "utf8", "-c", script], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python request failed with code ${code}`));
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse(stdout);
      } catch (error) {
        reject(new Error(`Python request returned invalid JSON: ${stdout}`));
        return;
      }

      if (!payload.ok) {
        reject(new Error(payload.error || "Python request failed"));
        return;
      }

      let data = null;
      try {
        data = payload.text ? JSON.parse(payload.text) : null;
      } catch (error) {
        data = null;
      }

      if (payload.status < 200 || payload.status >= 300) {
        const message = data?.error?.message || data?.error || data?.message || payload.text || `HTTP ${payload.status}`;
        reject(new Error(message));
        return;
      }

      resolve(data);
    });

    child.stdin.end(
      Buffer.from(
        JSON.stringify({
          url,
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body || null,
          timeout: 90,
        }),
        "utf8",
      ).toString("base64"),
    );
  });
}

function extractTextFromOpenAIResponse(payload) {
  const choice = payload?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (!Array.isArray(choice)) return "";
  return choice
    .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
    .join("\n");
}

function extractTextFromAnthropicResponse(payload) {
  const content = payload?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item?.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function extractTextFromGoogleResponse(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((item) => item?.text || "").filter(Boolean).join("\n");
}

async function callTextModelJson(appConfig, { systemPrompt, userPrompt, useSearch = false }) {
  const provider = appConfig.textProvider;
  assertConfigured(provider.apiKey, "文本模型 API Key");

  if (provider.apiStyle === "google") {
    const data = await withRetries(
      () =>
        fetchJsonViaPython(joinUrl(provider.baseUrl, `/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": provider.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            ...(useSearch && provider.searchEnabled ? { tools: [{ google_search: {} }] } : {}),
            generationConfig: { temperature: 0.7 },
          }),
        }),
      { retries: 3, delayMs: 1200 },
    );
    return parseJsonFromModelText(extractTextFromGoogleResponse(data));
  }

  if (provider.apiStyle === "anthropic") {
    const data = await withRetries(
      () =>
        fetchJson(joinUrl(provider.anthropicBaseUrl, "/messages"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": provider.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: provider.model,
            system: systemPrompt,
            max_tokens: 4096,
            messages: [{ role: "user", content: userPrompt }],
          }),
        }),
      { retries: 3, delayMs: 1200 },
    );
    return parseJsonFromModelText(extractTextFromAnthropicResponse(data));
  }

  const data = await withRetries(
    () =>
      fetchJson(joinUrl(provider.openaiBaseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: 0.7,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      }),
    { retries: 3, delayMs: 1200 },
  );
  return parseJsonFromModelText(extractTextFromOpenAIResponse(data));
}

const TREND_BUCKET_META = [
  {
    key: "xhs",
    title: "小红书热点话题",
    description: "从小红书站内高讨论、高收藏、高互动内容里筛选可被品牌借势的话题方向。",
    promptDescription: "聚焦小红书站内高讨论、高收藏、高互动、易被笔记化的话题方向。",
  },
  {
    key: "news",
    title: "新闻热点趋势",
    description: "从近期新闻、行业动态和消费趋势中找到可被品牌内容化的机会。",
    promptDescription: "聚焦近期新闻、行业动态、消费趋势中可内容化的机会。",
  },
  {
    key: "social",
    title: "社会热点趋势",
    description: "从大众情绪、生活方式变化、社会议题和公共讨论中找到适合品牌表达的切口。",
    promptDescription: "聚焦大众情绪、生活方式变化、社会议题、节日节点和公共讨论中适合品牌表达的切口。",
  },
  {
    key: "traffic",
    title: "流量热点趋势",
    description: "从小红书站内爆款形式、标题结构、场景表达和内容套路中找到流量机会。",
    promptDescription: "聚焦小红书站内正在被大量模仿、搜索、转发或评论的内容形式、标题结构、场景表达和爆款笔记套路。",
  },
  {
    key: "track",
    title: "赛道热点趋势",
    description: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
    promptDescription: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
  },
  {
    key: "crowd",
    title: "人群热点趋势",
    description: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
    promptDescription: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
  },
];

const TREND_BUCKET_GROUPS = [
  TREND_BUCKET_META.slice(0, 3),
  TREND_BUCKET_META.slice(3, 6),
];

function formatBucketKeys(bucketMeta) {
  return bucketMeta.map((bucket) => bucket.key).join("、");
}

function formatBucketTitles(bucketMeta) {
  return bucketMeta.map((bucket) => bucket.title).join("、");
}

function buildTrendAnalysisSystemPrompt(bucketMeta = TREND_BUCKET_META) {
  const bucketLines = bucketMeta.map((bucket) => `${bucket.key} 标题为${bucket.title}，${bucket.promptDescription}`);
  return [
    "你是资深小红书内容运营策略顾问，擅长品牌定位、热点适配判断与内容选题策划。",
    `你的任务是根据品牌档案，围绕小红书平台上的真实内容语境，分 ${bucketMeta.length} 个维度输出适合该品牌借势的热点趋势，并给出可执行内容选题。`,
    "所有趋势都要优先判断其在小红书上的讨论价值、内容扩散潜力、用户搜索/收藏/互动意愿和品牌适配度，不要写成泛泛的全网热点报告。",
    "请只输出 JSON，不要输出 Markdown，不要补充解释。",
    'JSON 顶层结构必须是：{"trendBuckets":[...]}。',
    `trendBuckets 必须输出 ${bucketMeta.length} 个对象，key 分别是 ${formatBucketKeys(bucketMeta)}。`,
    ...bucketLines,
    "每个 bucket 必须包含：key, title, description, items。",
    "每个 items 必须输出 10 条 trend。",
    "每条 trend 必须包含：title, category, summary, score, tags, reason, ideas。",
    "score 必须是 0 到 100 的整数，代表热度指数。",
    "热度指数评分标准：90-100 为爆发级热点，站内讨论强、内容供给增长快、品牌借势窗口短；80-89 为高潜热点，搜索/互动趋势明显，适合快速布局；70-79 为稳定热点，有持续内容需求，适合做系列化内容；60-69 为长尾热点，适合垂直人群或细分场景；60 以下为弱热点，除非品牌强相关，否则不建议优先选择。",
    "评分时综合考虑：小红书站内讨论度、搜索意图、互动/收藏潜力、内容可复制性、目标人群相关性、品牌自然植入度和近期时效性。不要编造具体播放量、搜索量、排名或机构数据。",
    "tags 必须是 3 到 5 个以 # 开头的字符串。",
    "ideas 必须是 2 条，每条 idea 必须包含：title, summary, angle, brandFit, audience, hook, tags。",
    "所有字段都用中文输出，允许品牌名保留原文。",
  ].join("\n");
}

function truncateForPrompt(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const headLength = Math.ceil(maxLength * 0.72);
  const tailLength = Math.max(80, maxLength - headLength - 18);
  return `${text.slice(0, headLength)}……（中间内容已压缩）……${text.slice(-tailLength)}`;
}

function compactBrandForPrompt(brand, mode = "standard") {
  const compact = mode === "minimal";
  return {
    ...brand,
    name: truncateForPrompt(brand.name, 80),
    industry: truncateForPrompt(brand.industry, 120),
    audience: truncateForPrompt(brand.audience, compact ? 180 : 320),
    description: truncateForPrompt(brand.description, compact ? 420 : 900),
    product: truncateForPrompt(brand.product, compact ? 360 : 700),
    goal: truncateForPrompt(brand.goal, compact ? 220 : 420),
    knowledgeBase: truncateForPrompt(brand.knowledgeBase, compact ? 360 : 900),
    assetTags: Array.isArray(brand.assetTags) ? brand.assetTags.slice(0, 6) : [],
  };
}

function buildTrendAnalysisUserPrompt(brand, options = {}, bucketMeta = TREND_BUCKET_META) {
  const promptBrand = compactBrandForPrompt(brand, options.minimal ? "minimal" : "standard");
  const strictLines = options.strict
    ? [
        `重要：必须返回 trendBuckets，且 ${formatBucketKeys(bucketMeta)} ${bucketMeta.length} 个 bucket 的 items 都不能为空。`,
        "如果搜索结果不足，请基于可验证的趋势方向表达，不要编造具体机构、日期或数据。",
        "只返回 JSON 对象，不要解释失败原因，不要输出自然语言说明。",
      ]
    : [];
  return [
    `请基于以下品牌信息，围绕小红书平台的热点话题与内容机会，按 ${bucketMeta.length} 个维度生成热点趋势与选题。`,
    "",
    `品牌名称：${promptBrand.name}`,
    `行业：${promptBrand.industry}`,
    `目标受众：${promptBrand.audience}`,
    `品牌介绍：${promptBrand.description}`,
    `产品/服务：${promptBrand.product}`,
    `运营目标：${promptBrand.goal}`,
    `品牌资料库：${promptBrand.knowledgeBase || "暂无补充资料"}`,
    `品牌资产标签：${(promptBrand.assetTags || []).join("、") || "暂无"}`,
    "",
    "要求：",
    `1. 每个维度都输出 10 条趋势，共 ${bucketMeta.length * 10} 条。`,
    `2. ${bucketMeta.length} 个维度依次为：${formatBucketTitles(bucketMeta)}。`,
    "3. 趋势名称要像真实小红书内容方向，而不是宏观行业报告标题。",
    "4. 每条趋势都要解释为什么适合该品牌，尤其说明它和品牌、人群、内容场景之间的自然连接。",
    "5. score 要严格按热度指数评分标准给出，不要所有趋势都给高分；优先把 80 分以上留给真正具备快速借势价值的趋势。",
    "6. 选题要能直接给运营同学使用，标题、角度、钩子都要有小红书笔记感，避免空泛文案。",
    "7. 如果涉及新闻、社会议题或近期热点，请表达为可验证的趋势或议题方向，不要编造具体机构、日期、排名或数据。",
    ...strictLines,
  ].join("\n");
}

function buildIdeaRegenerationSystemPrompt() {
  return [
    "你是一名小红书内容策划专家，擅长把品牌资产与热点趋势组合成可执行选题。",
    "请只输出 JSON，不要输出 Markdown，不要补充解释。",
    'JSON 顶层结构必须是：{"ideas":[...]}。',
    "ideas 必须输出 2 条。",
    "每条 idea 必须包含：title, summary, angle, brandFit, audience, hook, tags。",
    "tags 必须是 3 到 5 个以 # 开头的字符串。",
    "所有字段用中文输出。",
  ].join("\n");
}

function buildIdeaRegenerationUserPrompt(brand, trend, customPrompt) {
  const lines = [
    "请围绕下面这条热点，为品牌重新生成 2 条更适合的小红书内容选题。",
    "",
    `品牌名称：${brand.name}`,
    `行业：${brand.industry}`,
    `目标受众：${brand.audience}`,
    `品牌介绍：${brand.description}`,
    `产品/服务：${brand.product}`,
    `运营目标：${brand.goal}`,
    `品牌资料库：${brand.knowledgeBase || "暂无补充资料"}`,
    `品牌资产标签：${(brand.assetTags || []).join("、") || "暂无"}`,
    "",
    `热点标题：${trend.title}`,
    `热点分类：${trend.category}`,
    `热点摘要：${trend.summary}`,
    `热点适配原因：${trend.reason}`,
  ];
  lines.push(customPrompt ? `补充要求：${customPrompt}` : "补充要求：无，请给出默认版本。");
  lines.push("请保持品牌相关性和小红书内容感，不要输出过度营销化的空话。");
  return lines.join("\n");
}

function getSystemIdeaPrompt(brand, trend) {
  return [
    "你是一名小红书内容策划专家。",
    `品牌名称：${brand.name}`,
    `行业：${brand.industry}`,
    `目标受众：${brand.audience}`,
    `产品/服务：${brand.product}`,
    `运营目标：${brand.goal}`,
    `品牌资料库：${brand.knowledgeBase || "暂无额外资料库"}`,
    `品牌资产标签：${(brand.assetTags || []).join("、")}`,
    `热点标题：${trend.title}`,
    `热点分类：${trend.category}`,
    `热点适配原因：${trend.reason}`,
    "请生成适合该品牌的小红书内容选题，输出标题、内容摘要、切入角度、品牌结合方式、面向人群、开头钩子和推荐标签。",
  ].join("\n");
}

function normalizeTrendSet(rawTrends, brand, baseId) {
  const source = Array.isArray(rawTrends) ? rawTrends : rawTrends && typeof rawTrends === "object" ? Object.values(rawTrends) : [];
  return source
    .map(normalizeRawTrend)
    .filter((trend) => trend.title || trend.summary || trend.reason)
    .slice(0, 10)
    .map((trend, index) => ({
    id: baseId + index + 1,
    rank: index + 1,
    title: String(trend?.title || `趋势方向 ${index + 1}`),
    category: String(trend?.category || "内容趋势"),
    summary: String(trend?.summary || "暂无趋势摘要"),
    score: clampScore(trend?.score),
    tags: normalizeTags(trend?.tags, [`#${brand.name}`]),
    reason: String(trend?.reason || "暂无适配原因"),
    ideas: Array.isArray(trend?.ideas) && trend.ideas.length
      ? trend.ideas.slice(0, 2).map((idea) => sanitizeIdea(normalizeRawIdea(idea), brand.audience, `#${brand.name}`))
      : [],
    customPrompt: "",
    systemPrompt: "",
  }));
}

function normalizeRawTrend(trend) {
  if (typeof trend === "string") {
    return { title: trend };
  }
  if (!trend || typeof trend !== "object") return {};
  return {
    ...trend,
    title: trend.title || trend.name || trend.topic || trend.keyword || "",
    category: trend.category || trend.type || trend.bucket || trend.dimension || "",
    summary: trend.summary || trend.description || trend.desc || trend.insight || trend.content || "",
    score: trend.score ?? trend.heat ?? trend.heatScore ?? trend.index ?? trend.popularity,
    tags: trend.tags || trend.tagList || trend.hashtags || [],
    reason: trend.reason || trend.fitReason || trend.brandReason || trend.why || trend.rationale || "",
    ideas: trend.ideas || trend.contentIdeas || trend.topics || trend.topicIdeas || trend.suggestions || [],
  };
}

function normalizeRawIdea(idea) {
  if (typeof idea === "string") {
    return { title: idea };
  }
  if (!idea || typeof idea !== "object") return {};
  return {
    ...idea,
    title: idea.title || idea.name || idea.topic || "",
    summary: idea.summary || idea.description || idea.desc || idea.content || "",
    angle: idea.angle || idea.perspective || idea.direction || "",
    brandFit: idea.brandFit || idea.fit || idea.brandIntegration || "",
    audience: idea.audience || idea.targetAudience || idea.people || "",
    hook: idea.hook || idea.opening || idea.lead || "",
    tags: idea.tags || idea.tagList || idea.hashtags || [],
  };
}

function normalizeTrendBuckets(rawBuckets, rawTrends, brand, baseId, bucketMeta = TREND_BUCKET_META) {
  const sourceBuckets = coerceTrendBuckets(rawBuckets, bucketMeta);
  if (!sourceBuckets.length && rawTrends) {
    sourceBuckets.push({ key: bucketMeta[0]?.key || "bucket-1", items: rawTrends });
  }
  const bucketsByKey = new Map();
  sourceBuckets.forEach((bucket, index) => {
    const fallbackKey = bucketMeta[index]?.key || `bucket-${index + 1}`;
    const key = String(bucket?.key || bucket?.type || bucket?.name || fallbackKey);
    bucketsByKey.set(key, bucket);
    if (bucketMeta[index] && !bucketsByKey.has(bucketMeta[index].key)) {
      bucketsByKey.set(bucketMeta[index].key, bucket);
    }
  });

  return bucketMeta.map((meta, bucketIndex) => {
    const bucket = bucketsByKey.get(meta.key) || {};

    return {
      key: meta.key,
      title: meta.title,
      description: meta.description,
      items: normalizeTrendSet(bucket?.items || bucket?.trends || bucket?.hotspots || bucket?.list, brand, baseId + bucketIndex * 100),
    };
  });
}

function coerceTrendBuckets(rawBuckets, bucketMeta = TREND_BUCKET_META) {
  if (Array.isArray(rawBuckets)) return rawBuckets;
  if (!rawBuckets || typeof rawBuckets !== "object") return [];
  const expectedKeys = bucketMeta.map((bucket) => bucket.key);
  if (expectedKeys.some((key) => rawBuckets[key])) {
    return expectedKeys.filter((key) => rawBuckets[key]).map((key) => {
      const value = rawBuckets[key];
      return value && typeof value === "object" && !Array.isArray(value) ? { key, ...value } : { key, items: value };
    });
  }
  return Object.entries(rawBuckets).map(([key, value]) =>
    value && typeof value === "object" && !Array.isArray(value) ? { key, ...value } : { key, items: value },
  );
}

function unwrapTrendModelResult(result) {
  if (Array.isArray(result)) return { rawBuckets: result, rawTrends: null };
  const source = result?.trendBuckets || result?.buckets || result?.trend_buckets || result?.data?.trendBuckets || result?.result?.trendBuckets;
  const rawTrends = result?.trends || result?.items || result?.hotspots || result?.data?.trends || null;
  return { rawBuckets: source, rawTrends };
}

function hasUsableTrendBuckets(trendBuckets, bucketMeta = TREND_BUCKET_META) {
  const requiredKeys = new Set(bucketMeta.map((bucket) => bucket.key));
  return (
    Array.isArray(trendBuckets) &&
    trendBuckets.length === bucketMeta.length &&
    trendBuckets.every((bucket) => requiredKeys.has(bucket.key) && Array.isArray(bucket.items) && bucket.items.length > 0)
  );
}

async function generateAiTrendSet(appConfig, brand, baseId) {
  const allBuckets = [];
  for (let groupIndex = 0; groupIndex < TREND_BUCKET_GROUPS.length; groupIndex += 1) {
    const bucketMeta = TREND_BUCKET_GROUPS[groupIndex];
    const groupBuckets = await generateTrendBucketGroup(appConfig, brand, baseId + groupIndex * 1000, bucketMeta, groupIndex + 1);
    allBuckets.push(...groupBuckets);
  }
  return allBuckets;
}

async function generateTrendBucketGroup(appConfig, brand, baseId, bucketMeta, groupNumber) {
  const searchEnabled = Boolean(appConfig.textProvider.searchEnabled);
  const attempts = [
    { useSearch: searchEnabled, strict: false, minimal: false, label: "search-loose" },
    { useSearch: searchEnabled, strict: true, minimal: false, label: "search-strict" },
    { useSearch: searchEnabled, strict: true, minimal: true, label: "search-minimal" },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const userPrompt = buildTrendAnalysisUserPrompt(brand, {
        strict: attempt.strict,
        minimal: attempt.minimal,
      }, bucketMeta);
      console.log("[trend-analysis] calling text model", {
        brandId: brand.id,
        brandName: brand.name,
        group: groupNumber,
        bucketKeys: bucketMeta.map((bucket) => bucket.key),
        attempt: attempt.label,
        useSearch: attempt.useSearch,
        userPromptLength: userPrompt.length,
        descriptionLength: String(brand.description || "").length,
        productLength: String(brand.product || "").length,
        knowledgeBaseLength: String(brand.knowledgeBase || "").length,
      });
      const result = await callTextModelJson(appConfig, {
        systemPrompt: buildTrendAnalysisSystemPrompt(bucketMeta),
        userPrompt,
        useSearch: attempt.useSearch,
      });
      const { rawBuckets, rawTrends } = unwrapTrendModelResult(result);
      const trendBuckets = normalizeTrendBuckets(rawBuckets, rawTrends, brand, baseId, bucketMeta);
      if (hasUsableTrendBuckets(trendBuckets, bucketMeta)) {
        return trendBuckets;
      }
      lastError = new Error(`文本模型返回了 JSON，但没有完整的第 ${groupNumber} 组三类可用趋势 items。`);
      console.warn("[trend-analysis] text model returned empty trends", {
        brandId: brand.id,
        brandName: brand.name,
        group: groupNumber,
        bucketKeys: bucketMeta.map((bucket) => bucket.key),
        attempt: attempt.label,
        useSearch: attempt.useSearch,
        resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
        bucketSizes: trendBuckets.map((bucket) => ({ key: bucket.key, count: bucket.items.length })),
      });
    } catch (error) {
      lastError = error;
      console.warn("[trend-analysis] text model attempt failed", {
        brandId: brand.id,
        brandName: brand.name,
        group: groupNumber,
        bucketKeys: bucketMeta.map((bucket) => bucket.key),
        attempt: attempt.label,
        useSearch: attempt.useSearch,
        message: error?.message || "unknown error",
      });
    }
  }

  console.warn("[trend-analysis] failed without fallback", {
    brandId: brand.id,
    brandName: brand.name,
    group: groupNumber,
    bucketKeys: bucketMeta.map((bucket) => bucket.key),
    reason: lastError?.message || "empty model result",
  });
  throw new Error("本次分析未能获取到可用热点，请稍后重试。");
}

async function regenerateTrendIdeas(appConfig, brand, trend, customPrompt) {
  const systemPrompt = getSystemIdeaPrompt(brand, trend);
  let result;
  try {
    result = await callTextModelJson(appConfig, {
      systemPrompt: `${buildIdeaRegenerationSystemPrompt()}\n\n以下是默认品牌上下文：\n${systemPrompt}`,
      userPrompt: buildIdeaRegenerationUserPrompt(brand, trend, customPrompt),
      useSearch: false,
    });
  } catch (error) {
    throw new Error(`文本模型暂时不可用：${String(error.message || "unknown error")}`);
  }

  const ideas = Array.isArray(result?.ideas) ? result.ideas : [];
  if (!ideas.length) {
    throw new Error("文本模型未返回可用选题结果。");
  }

  return {
    systemPrompt,
    ideas: ideas.slice(0, 2).map((idea) => sanitizeIdea(idea, brand.audience, `#${brand.name}`)),
  };
}

function buildImageConceptMetadata({ brand, trend, idea }) {
  const seed = `${brand.name}|${trend.title}|${idea.title}|${idea.angle || ""}`;
  const captionTemplate = pickVariant(seed, [
    () => `最近看到“${trend.title}”这个话题，突然想到一个很具体的场景：${idea.summary}。如果把它放到日常里，${brand.name}能提供的价值其实会更自然地被看见。`,
    () => `有时候不需要把热点讲得很大，真正打动人的反而是一个细节。比如${idea.audience}正在关心的这件事，${idea.brandFit}就可以用很轻的方式说出来。`,
    () => `${idea.hook || trend.title} 这句话挺适合发朋友圈，不是为了追热点，而是把一个最近大家都有感的情绪，落到${brand.name}能陪伴或解决的真实场景里。`,
    () => `今天想从“${trend.title}”换个角度聊聊：好的内容不一定要很用力，能让人想到自己的生活、愿意停下来多看一眼，就已经很有价值了。`,
  ]);
  const visualTemplate = pickVariant(`${seed}|visual`, [
    () => `${brand.name}朋友圈生活方式分享图`,
    () => `围绕“${idea.title}”的朋友圈日常场景图`,
    () => `${trend.title}话题下的自然分享视觉`,
    () => `${brand.name}轻种草朋友圈配图`,
  ]);

  return {
    title: normalizeChineseCopy(`${brand.name} 朋友圈图`),
    caption: normalizeChineseCopy(captionTemplate()),
    visualDirection: normalizeChineseCopy(visualTemplate()),
    style: String(brand.industry || "").toLowerCase().includes("beauty") ? "clean lifestyle snapshot" : "natural lifestyle social post",
    composition: "朋友圈配图构图，画面像真实生活分享或轻度品牌种草，不做强海报排版，主体自然入镜，留白适中",
    prompt: normalizeChineseCopy(`为品牌${brand.name}生成一张适合微信朋友圈发布的配图，围绕“${idea.title}”这个内容选题，结合话题“${trend.title}”。画面要像真实朋友圈里的生活方式分享图，而不是小红书封面、广告海报或电商详情图。请把${idea.brandFit}融入一个${idea.audience}容易共鸣的日常场景中，整体自然、松弛、有真实感，有轻微品牌质感但不要过度营销。风格可参考${(brand.assetTags || []).join("、") || "品牌调性"}，画面干净、有生活温度，适合搭配一段朋友圈文案发布。不要堆砌大标题、夸张促销文字或复杂信息模块。参考品牌资料：${brand.knowledgeBase || "暂无额外资料"}。`),
  };
}

function extractWavespeedOutput(payload) {
  const outputs = payload?.data?.outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const first = outputs[0];
  if (typeof first === "string") return first;
  return first?.image || first?.url || first?.image_url || null;
}

function truncateLogValue(value, maxLength = 800) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeWavespeedError(payload) {
  const value = payload?.data?.error || payload?.error || "";
  if (!value) return "";
  return typeof value === "string" ? value : truncateLogValue(value, 1000);
}

function summarizeUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    return truncateLogValue(value, 200);
  }
}

function summarizeWavespeedPayload(payload) {
  const data = payload?.data || {};
  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  return {
    upstreamId: data.id || "",
    status: data.status || "",
    error: normalizeWavespeedError(payload),
    outputCount: outputs.length,
    hasGetResultUrl: Boolean(data.urls?.get || data.get_result_url),
    timings: data.timings || null,
    createdAt: data.created_at || data.createdAt || "",
    updatedAt: data.updated_at || data.updatedAt || "",
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
  };
}

function buildImageJobLogContext(job) {
  return {
    jobId: job.id,
    status: job.status,
    providerMode: job.providerMode,
    ageMs: Date.now() - job.createdAt,
    timeoutMs: IMAGE_JOB_TIMEOUT_MS,
    remainingMs: Math.max(0, IMAGE_JOB_TIMEOUT_MS - (Date.now() - job.createdAt)),
    hasResultUrl: Boolean(job.providerResultUrl),
    resultUrl: summarizeUrl(job.providerResultUrl),
    referenceImageUsed: Boolean(job.metadata?.referenceImageUsed),
    generationContext: job.generationContext || null,
  };
}

async function fetchWavespeedResultOnce(getUrl, headers) {
  const payload = await withRetries(() => fetchJson(getUrl, { headers, timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS }), {
    retries: 2,
    delayMs: 1500,
  });
  return {
    payload,
    imageUrl: extractWavespeedOutput(payload),
    status: payload?.data?.status || "",
    error: normalizeWavespeedError(payload),
    summary: summarizeWavespeedPayload(payload),
  };
}

async function createImageJob(
  appConfig,
  imageJobs,
  {
    brand,
    trend,
    idea,
    metadata: providedMetadata,
    productImage,
    productImages,
    logoImage,
    styleReferenceImages,
    sourceImageUrls,
    sourceImages,
    aspectRatio,
  },
) {
  const provider = appConfig.imageProvider;
  assertConfigured(provider.apiKey, "图片模型 API Key");
  const referenceImages = normalizeImageInputs(productImages || productImage);
  const logoImages = normalizeImageInputs(logoImage);
  const styleImages = normalizeImageInputs(styleReferenceImages);
  const localSourceImages = normalizeImageInputs(sourceImages);
  const sourceUrls = normalizeSourceImageUrls(sourceImageUrls);
  const useReferenceImages = referenceImages.length > 0 || logoImages.length > 0 || styleImages.length > 0;
  const metadata = withImageReferencePrompt(providedMetadata || buildImageConceptMetadata({ brand, trend, idea }), {
    productImages: referenceImages,
    logoImages,
    styleImages,
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
  const uploadedProductUrls = referenceImages.length ? await Promise.all(referenceImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedLogoUrls = logoImages.length ? await Promise.all(logoImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedStyleUrls = styleImages.length ? await Promise.all(styleImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedSourceUrls = localSourceImages.length ? await Promise.all(localSourceImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedImageUrls = [...uploadedProductUrls, ...uploadedLogoUrls, ...uploadedStyleUrls];
  const editImageUrls = [...sourceUrls, ...uploadedSourceUrls, ...uploadedImageUrls];
  const useEditModel = editImageUrls.length > 0;
  const endpoint = useEditModel ? provider.editBaseUrl || provider.baseUrl : provider.baseUrl;
  const outputAspectRatio = aspectRatio || metadata.aspectRatio || provider.aspectRatio;
  const body = {
    prompt: metadata.prompt,
    aspect_ratio: outputAspectRatio,
    resolution: provider.resolution,
    quality: provider.quality,
    enable_sync_mode: false,
    enable_base64_output: false,
    ...(useEditModel ? { images: editImageUrls } : {}),
  };

  console.log("[image-job] creating upstream task", {
    brandId: brand?.id,
    trendId: trend?.id,
    ideaTitle: idea?.title || "",
    providerMode: useEditModel ? "edit" : "text-to-image",
    endpoint: summarizeUrl(endpoint),
    aspectRatio: outputAspectRatio,
    resultResolution: provider.resolution,
    resultQuality: provider.quality,
    hasReferenceImage: useReferenceImages,
    referenceImageCount: referenceImages.length,
    referenceImageNames: referenceImages.map((image) => image.name || "").filter(Boolean),
    logoImageCount: logoImages.length,
    styleReferenceImageCount: styleImages.length,
    sourceImageCount: sourceUrls.length + localSourceImages.length,
    uploadedReferenceUrls: uploadedImageUrls.map(summarizeUrl),
    uploadedSourceUrls: uploadedSourceUrls.map(summarizeUrl),
    promptLength: String(metadata.prompt || "").length,
    promptPreview: truncateLogValue(metadata.prompt || "", 300),
    bodyImageCount: editImageUrls.length,
  });

  let initial = null;
  try {
    initial = await withRetries(
      () =>
        fetchJson(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS,
        }),
      { retries: 3, delayMs: 2000 },
    );
  } catch (error) {
    console.error("[image-job] upstream task create failed", {
      brandId: brand?.id,
      trendId: trend?.id,
      ideaTitle: idea?.title || "",
      providerMode: useEditModel ? "edit" : "text-to-image",
      endpoint: summarizeUrl(endpoint),
      statusCode: error?.statusCode || null,
      message: error?.message || "unknown error",
      responseBody: truncateLogValue(error?.rawBody || error?.payload || "", 1500),
    });
    throw error;
  }

  const resultUrl = initial?.data?.urls?.get || initial?.data?.get_result_url;
  const imageUrl = extractWavespeedOutput(initial);
  console.log("[image-job] upstream task accepted", {
    ...summarizeWavespeedPayload(initial),
    resultUrl: summarizeUrl(resultUrl),
    hasDirectImageUrl: Boolean(imageUrl),
  });
  const job = {
    id: randomId(),
    status: imageUrl ? "completed" : "pending",
    createdAt: Date.now(),
    provider: "wavespeed",
    providerMode: useEditModel ? "edit" : "text-to-image",
    providerResultUrl: resultUrl || "",
    providerHeaders: headers,
    model: provider.model,
    metadata: {
      ...metadata,
      aspectRatio: outputAspectRatio,
      sourceImageUrls: [...sourceUrls, ...uploadedSourceUrls],
      referenceImageName: referenceImages[0]?.name || "",
      referenceImageNames: referenceImages.map((image) => image.name || "").filter(Boolean),
      referenceImageUrl: uploadedImageUrls[0] || "",
      referenceImageUrls: uploadedProductUrls,
      logoImageUrls: uploadedLogoUrls,
      styleReferenceImageUrls: uploadedStyleUrls,
      referenceImageCount: referenceImages.length,
      referenceImageUsed: useReferenceImages,
      logoImageUsed: logoImages.length > 0,
      styleReferenceImageUsed: styleImages.length > 0,
    },
    imageUrl: imageUrl || "",
    error: "",
  };

  if (!job.imageUrl && !job.providerResultUrl) {
    throw new Error("图片服务未返回可轮询的任务地址。");
  }

  imageJobs.set(job.id, job);
  return job;
}

function normalizeImageInputs(input) {
  const images = Array.isArray(input) ? input : input ? [input] : [];
  return images
    .filter((image) => image?.dataUrl)
    .map((image) => ({
      ...image,
      name: String(image.name || image.fileName || "product-image.png"),
      dataUrl: String(image.dataUrl || ""),
    }))
    .slice(0, 8);
}

function normalizeSourceImageUrls(input) {
  const urls = Array.isArray(input) ? input : input ? [input] : [];
  return urls.map((url) => String(url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).slice(0, 8);
}

async function uploadProductImage(provider, productImage) {
  if (!provider.uploadBaseUrl) {
    throw new Error("图片编辑需要先配置 IMAGE_UPLOAD_BASE_URL。");
  }

  const parsed = parseDataUrl(productImage.dataUrl);
  const fileName = productImage.name || "product-image.png";

  console.log("[image-job] uploading reference image", {
    uploadUrl: summarizeUrl(provider.uploadBaseUrl),
    fileName,
    mimeType: parsed.mimeType,
    bytes: parsed.buffer.length,
  });

  const response = await withRetries(
    () => {
      const formData = new FormData();
      formData.append("file", new Blob([parsed.buffer], { type: parsed.mimeType }), fileName);
      return (
      fetch(provider.uploadBaseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: formData,
      })
      );
    },
    { retries: 3, delayMs: 1500 },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[image-job] reference image upload failed", {
      uploadUrl: summarizeUrl(provider.uploadBaseUrl),
      status: response.status,
      statusText: response.statusText,
      responseSummary: truncateLogValue(payload, 1500),
    });
    throw new Error(payload?.error?.message || payload?.error || payload?.message || `产品图上传失败：HTTP ${response.status}`);
  }

  const url = payload?.data?.download_url || payload?.data?.url || payload?.download_url || payload?.url || "";
  if (!url) {
    console.error("[image-job] reference image upload missing url", {
      uploadUrl: summarizeUrl(provider.uploadBaseUrl),
      status: response.status,
      responseSummary: truncateLogValue(payload, 1500),
    });
    throw new Error("产品图上传成功但未返回可用于生图的图片 URL。");
  }
  console.log("[image-job] reference image uploaded", {
    uploadUrl: summarizeUrl(provider.uploadBaseUrl),
    imageUrl: summarizeUrl(url),
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    dataKeys: payload?.data && typeof payload.data === "object" ? Object.keys(payload.data) : [],
  });
  return url;
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("产品图格式无效，请重新上传图片。");
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function withImageReferencePrompt(metadata, { productImages, logoImages, styleImages }) {
  const productCount = Array.isArray(productImages) ? productImages.length : 0;
  const logoCount = Array.isArray(logoImages) ? logoImages.length : 0;
  const styleCount = Array.isArray(styleImages) ? styleImages.length : 0;
  if (!productCount && !logoCount && !styleCount) return metadata;
  const hints = [];
  if (productCount) {
    hints.push(
      productCount === 1
        ? "请参考输入图片中的产品外观、材质、包装、颜色和品牌识别元素，把该产品自然融入画面；不要改变产品核心造型，不要生成与参考产品冲突的包装。"
        : `请参考输入的 ${productCount} 张产品图，把这些图片中的物品作为画面主体或主体组合；保留各产品的核心造型、材质、包装、颜色和品牌识别元素，不要混淆不同产品，不要生成与参考产品冲突的包装。`,
    );
  }
  if (logoCount) {
    hints.push("请把输入的品牌 Logo 作为产品/品牌标识使用，保持 Logo 文字和图形清晰、比例正确；不要把 Logo 当成独立产品主体，也不要改写 Logo。");
  }
  if (styleCount) {
    hints.push("请参考输入的风格图来借鉴色调、光影、版式、材质和整体氛围，但不要直接复制风格图里的具体物体或文字。");
  }
  return {
    ...metadata,
    prompt: `${metadata.prompt}\n\n${hints.join("\n")}`,
  };
}

async function resolveImageJob(appConfig, imageJobs, job) {
  if (job.status === "completed" || job.status === "failed") {
    return job;
  }

  try {
    const polled = await fetchWavespeedResultOnce(job.providerResultUrl, getImageJobProviderHeaders(appConfig, job));
    console.log("[image-job] polled upstream result", {
      ...buildImageJobLogContext(job),
      upstreamStatus: polled.status || "",
      hasImageUrl: Boolean(polled.imageUrl),
      upstreamError: polled.error || "",
      upstreamSummary: polled.summary,
    });
    if (polled.imageUrl) {
      job.status = "completed";
      job.imageUrl = polled.imageUrl;
      console.log("[image-job] completed", {
        ...buildImageJobLogContext(job),
        imageUrl: summarizeUrl(job.imageUrl),
      });
    } else if (polled.status === "failed" || polled.error) {
      job.status = "failed";
      job.error = polled.error || "图片生成失败";
      console.error("[image-job] upstream marked failed", {
        ...buildImageJobLogContext(job),
        error: job.error,
        upstreamSummary: polled.summary,
        upstreamPayload: truncateLogValue(polled.payload, 2000),
      });
    } else if (Date.now() - job.createdAt > IMAGE_JOB_TIMEOUT_MS) {
      job.status = "failed";
      job.error = "图片生成超时，请稍后重试。";
      console.error("[image-job] timed out", {
        ...buildImageJobLogContext(job),
        upstreamSummary: polled.summary,
      });
    } else {
      job.status = "pending";
    }
  } catch (error) {
    console.error("[image-job] polling error", {
      ...buildImageJobLogContext(job),
      message: error?.message || "unknown error",
      statusCode: error?.statusCode || null,
      responseBody: truncateLogValue(error?.rawBody || error?.payload || "", 1500),
    });
    if (Date.now() - job.createdAt > IMAGE_JOB_TIMEOUT_MS) {
      job.status = "failed";
      job.error = error.message || "图片生成失败";
    } else {
      job.status = "pending";
    }
  }

  imageJobs.set(job.id, job);
  return job;
}

function buildImageJobResponse(job) {
  return {
    jobId: job.id,
    status: job.status,
    elapsedMs: Date.now() - job.createdAt,
    timeoutMs: IMAGE_JOB_TIMEOUT_MS,
    imageConcept:
      job.status === "completed"
        ? {
            ...job.metadata,
            previewUrl: job.imageUrl,
            imageUrl: job.imageUrl,
            provider: job.provider,
            model: job.model,
          }
        : null,
    error: job.error || "",
  };
}

function getImageJobProviderHeaders(appConfig, job) {
  if (job.providerHeaders?.Authorization) return job.providerHeaders;
  assertConfigured(appConfig.imageProvider.apiKey, "图片模型 API Key");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${appConfig.imageProvider.apiKey}`,
  };
}

function buildTextProviderEndpoint(appConfig) {
  if (appConfig.textProvider.apiStyle === "anthropic") {
    return joinUrl(appConfig.textProvider.anthropicBaseUrl, "/messages");
  }
  if (appConfig.textProvider.apiStyle === "google") {
    return joinUrl(
      appConfig.textProvider.baseUrl,
      `/v1beta/models/${encodeURIComponent(appConfig.textProvider.model)}:generateContent`,
    );
  }
  return joinUrl(appConfig.textProvider.openaiBaseUrl, "/chat/completions");
}

module.exports = {
  createAiServices,
};
