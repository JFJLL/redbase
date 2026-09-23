const path = require("path");
const projectRoot = path.resolve(__dirname, "..");
const db = require("better-sqlite3")(path.join(projectRoot, "data/redbase.sqlite"));
const { loadAppConfig } = require(path.join(projectRoot, "src/server/config"));
const { fetchZhihuSearchEvidence } = require(path.join(projectRoot, "src/server/integrations/zhihu-search"));
const { callTextModelJson } = require(path.join(projectRoot, "src/server/ai/text-provider"));
const { generateAiTrendSet } = require(path.join(projectRoot, "src/server/ai/trend-service"));

async function runIntegrationTest() {
  console.log("=== [1/4] 加载配置 ===");
  const appConfig = loadAppConfig();
  console.log("配置确认:", {
    textModel: appConfig.textProvider.model,
    textEndpoint: appConfig.textProvider.openaiBaseUrl,
    keysCount: appConfig.textProvider.apiKeys?.length,
    searchProvider: appConfig.searchProvider.type,
    searchEnabled: appConfig.searchProvider.enabled,
  });

  console.log("\n=== [2/4] 测试知乎全网搜索适配器 ===");
  const brand = db.prepare("SELECT * FROM brands WHERE id = 1").get();
  const t0 = Date.now();
  const searchEvidence = await fetchZhihuSearchEvidence(appConfig, brand, [{ key: "news" }], {
    allowSparseEvidence: true,
    skipCache: true,
  });
  console.log("知乎搜索返回成功:", {
    provider: searchEvidence.provider,
    evidenceCount: searchEvidence.evidence?.length,
    candidatesCount: searchEvidence.candidates?.length,
    elapsedMs: Date.now() - t0,
    sampleEvidence: searchEvidence.evidence?.[0] ? {
      id: searchEvidence.evidence[0].id,
      title: searchEvidence.evidence[0].title,
      url: searchEvidence.evidence[0].url,
      source: searchEvidence.evidence[0].source,
      publishedAt: searchEvidence.evidence[0].publishedAt,
    } : null,
  });

  console.log("\n=== [3/4] 测试 Agnes Key 轮询与文本模型调用 ===");
  for (let i = 1; i <= 3; i++) {
    const res = await callTextModelJson(appConfig, {
      systemPrompt: "你是一个测试助手，请输出 JSON 格式：{\"status\": \"ok\", \"round\": <数字>}",
      userPrompt: `这是第 ${i} 次调用，请回复确认。`,
    });
    console.log(`Round ${i} 响应:`, res);
  }

  console.log("\n=== [4/4] 测试趋势生成完整端到端链路 (知乎搜索 -> Agnes 生成) ===");
  const tTrend = Date.now();
  const trendResult = await generateAiTrendSet(appConfig, brand, "test-zhihu-agnes", {
    bucketKey: "news",
    freeForm: false,
  });
  const trends = Array.isArray(trendResult)
    ? trendResult[0]?.items || []
    : trendResult.trends || [];
  console.log("趋势生成成功! 耗时:", ((Date.now() - tTrend) / 1000).toFixed(1) + "s");
  console.log("生成趋势数量:", trends.length);
  if (trends.length > 0) {
    console.log("首个趋势详情:", {
      title: trends[0].title,
      category: trends[0].category,
      evidenceIds: trends[0].evidenceIds,
      summary: trends[0].summary?.slice(0, 80) + "...",
    });
  }

  console.log("\n全部测试通过！");
}

runIntegrationTest().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
