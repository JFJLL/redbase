const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractMarketSignals,
  extractMarketSignalsFromSources,
  formatMarketSignalsPromptBlock,
  isEmptyPlatitude,
} = require("../src/server/ai/trend-signal-extractor");
const {
  validateTrendQuality,
  filterTrendsByQuality,
  getTrendQualityIssues,
  buildTrendAnalysisUserPrompt,
  buildTrendAnalysisSystemPrompt,
  TREND_BUCKET_META,
} = require("../src/server/ai/trend-service");

const brand = {
  id: 1,
  name: "LightMate",
  industry: "家居照明",
  audience: "租房与居家办公人群",
  product: "折叠桌面灯",
  description: "小空间便携照明",
  goal: "发现近期内容机会",
};

test("extractMarketSignals turns evidence into concrete market signals", () => {
  const { signals } = extractMarketSignals({
    brand,
    evidence: [
      {
        id: "S1",
        title: "租房桌面从固定台灯转向折叠便携照明",
        snippet: "用户吐槽桌面拥挤，需要可收纳补光；桌面太挤了真的难放下台灯。",
        sourceType: "web",
        trustLevel: "medium",
        publishedAt: "2026-07-16",
      },
      {
        id: "S2",
        title: "居家办公补光讨论",
        snippet: "家长和上班族开始更关注键盘区与屏幕区的分区补光。",
        sourceType: "social",
        trustLevel: "low",
      },
    ],
  });

  assert.ok(signals.length >= 1);
  for (const signal of signals) {
    assert.ok(signal.keyword);
    assert.ok(signal.change);
    assert.ok(signal.consumer_language);
    assert.ok(signal.consumer_need);
    assert.ok(Number.isInteger(signal.confidence));
    assert.ok(signal.confidence >= 0 && signal.confidence <= 100);
    assert.equal(isEmptyPlatitude(signal.change), false);
  }
});

test("formatMarketSignalsPromptBlock is injected into trend user prompt", () => {
  const marketSignals = extractMarketSignalsFromSources({
    brand,
    anySearchEvidence: {
      evidence: [{
        id: "S1",
        title: "用户开始更关注桌面线材冲突与移动补光",
        snippet: "求问小空间桌面怎么选折叠灯，怕线材乱和搬动麻烦。",
        sourceType: "web",
        trustLevel: "medium",
        publishedAt: "2026-07-16",
      }],
    },
  });
  const block = formatMarketSignalsPromptBlock(marketSignals);
  assert.match(block, /市场信号层/);
  assert.match(block, /关键词/);

  const prompt = buildTrendAnalysisUserPrompt(
    brand,
    {
      marketSignals,
      anySearchEvidence: {
        evidence: [{
          id: "S1",
          title: "用户开始更关注桌面线材冲突与移动补光",
          snippet: "求问小空间桌面怎么选折叠灯。",
          sourceType: "web",
          trustLevel: "medium",
          source: "ce.cn",
          host: "ce.cn",
        }],
      },
    },
    [TREND_BUCKET_META.find((item) => item.key === "traffic")],
  );
  assert.match(prompt, /市场信号层/);
  assert.match(prompt, /market_change/);
  assert.match(prompt, /brand_opportunity/);
  assert.match(prompt, /content_direction/);
  assert.match(prompt, /消费升级/);

  const systemPrompt = buildTrendAnalysisSystemPrompt(
    [TREND_BUCKET_META.find((item) => item.key === "traffic")],
    { trendCount: 10 },
  );
  assert.match(systemPrompt, /营销机会/);
  assert.match(systemPrompt, /market_change/);
  assert.match(systemPrompt, /禁止空话套话/);
});

test("validateTrendQuality discards empty or platitude opportunity cards", () => {
  assert.equal(validateTrendQuality({
    title: "机会A",
    market_change: "用户从固定台灯讨论转向折叠便携补光",
    brand_opportunity: "品牌可在小空间摆位场景展示折叠灯归位动作",
    content_direction: "做桌面摆位前后对照组图",
  }), true);

  assert.equal(validateTrendQuality({
    title: "空机会",
    market_change: "",
    brand_opportunity: "有机会",
    content_direction: "做内容",
  }), false);

  assert.equal(validateTrendQuality({
    title: "空话",
    market_change: "消费升级带来新机会",
    brand_opportunity: "年轻人关注健康",
    content_direction: "品质生活种草",
  }), false);

  const buckets = [{
    key: "traffic",
    items: [
      {
        title: "keep",
        market_change: "讨论从外观种草转向分区补光过程",
        brand_opportunity: "用折叠灯进入居家办公分区补光场景",
        content_direction: "做任务分区补光清单",
      },
      {
        title: "drop",
        market_change: "",
        brand_opportunity: "适合品牌",
        content_direction: "做内容",
      },
    ],
  }];
  const filtered = filterTrendsByQuality(buckets);
  assert.equal(filtered[0].items.length, 1);
  assert.equal(filtered[0].items[0].title, "keep");

  const issues = getTrendQualityIssues(buckets);
  assert.ok(issues.some((issue) => issue.reason === "missing-opportunity-field" && issue.field === "market_change"));
});
