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
  getTrendGenerationIssues,
  normalizeTrendSet,
  buildTrendAnalysisUserPrompt,
  buildTrendAnalysisSystemPrompt,
  TREND_BUCKET_META,
} = require("../src/server/ai/trend-service");
const {
  isInvalidGenericTrendText,
  getTrendSelfScoreIssue,
  TREND_SELF_SCORE_MIN,
} = require("../src/server/ai/trend-guardrails");

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
  assert.match(systemPrompt, /品牌策略负责人/);
  assert.match(systemPrompt, /novelty_score/);
  assert.match(systemPrompt, /消费者越来越关注健康/);
  assert.match(systemPrompt, /过去→现在/);
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

test("invalid generic trend and self-score gates improve strategy quality", () => {
  assert.equal(isInvalidGenericTrendText("消费者越来越关注健康"), true);
  assert.equal(isInvalidGenericTrendText("租房用户从固定台灯转向折叠补光"), false);

  assert.equal(getTrendSelfScoreIssue({
    novelty_score: 80,
    brand_fit_score: 82,
    actionability_score: 75,
  }), null);
  assert.equal(getTrendSelfScoreIssue({
    novelty_score: 60,
    brand_fit_score: 82,
    actionability_score: 75,
  })?.reason, "low-self-score");
  assert.ok(TREND_SELF_SCORE_MIN >= 70);

  const normalized = normalizeTrendSet([{
    title: "折叠桌面灯分区补光讨论升温",
    category: "内容机会",
    market_change: "用户从固定台灯讨论转向折叠便携补光",
    consumer_shift: "租房人群更在意桌面收纳与移动补光",
    why_now: "近期讨论集中在小空间线材冲突",
    brand_opportunity: "LightMate 可展示折叠灯归位动作",
    content_direction: "做桌面摆位前后对照组图",
    summary: "用户从固定台灯讨论转向折叠便携补光；租房人群更在意桌面收纳与移动补光",
    reason: "折叠桌面灯分区补光讨论升温，可做成小空间补光清单并自然带入品牌收纳动作，边界是讨论样本而非全网热度。",
    score: 78,
    novelty_score: 80,
    brand_fit_score: 85,
    actionability_score: 76,
    tags: ["#折叠灯", "#桌面补光", "#小空间"],
    ideas: [
      {
        title: "租房桌面折叠灯摆位对照",
        summary: "展示拥挤桌面到折叠归位的前后对比，说明小空间补光怎么收。",
        angle: "前后对照 + 收纳动作",
        brandFit: "用 LightMate 折叠灯完成归位演示",
        audience: "租房居家办公人群",
        hook: "桌面太挤了，灯还能这样收？",
        tags: ["#租房改造", "#桌面收纳", "#补光"],
      },
      {
        title: "分区补光任务清单",
        summary: "按键盘区屏幕区分区补光，讲清便携灯怎么跟着任务移动。",
        angle: "任务清单 + 分区场景",
        brandFit: "把折叠灯放进居家办公任务流",
        audience: "居家办公租房党",
        hook: "补光不是越亮越好，分区才重要",
        tags: ["#居家办公", "#分区补光", "#折叠灯"],
      },
    ],
  }], brand, 100);

  assert.equal(normalized[0].novelty_score, 80);
  assert.equal(normalized[0].brand_fit_score, 85);
  assert.equal(normalized[0].actionability_score, 76);

  const badItem = {
    ...normalized[0],
    title: "消费者越来越关注健康带来新机会",
    novelty_score: 50,
    brand_fit_score: 80,
    actionability_score: 80,
  };
  // Pad to TREND_ITEMS_PER_BUCKET so structure checks reach content gates.
  const items = Array.from({ length: 10 }, (_, index) => (
    index === 0
      ? badItem
      : {
        ...normalized[0],
        title: `${normalized[0].title}-${index}`,
        stableKey: `sk-${index}`,
        novelty_score: 80,
        brand_fit_score: 80,
        actionability_score: 80,
      }
  ));
  const structureIssues = getTrendGenerationIssues(
    [{
      key: "traffic",
      title: "流量",
      description: "",
      items,
    }],
    [TREND_BUCKET_META.find((item) => item.key === "traffic")],
    null,
    brand,
    null,
  );
  assert.ok(structureIssues.some((issue) => issue.reason === "invalid-generic-trend"));
  assert.ok(structureIssues.some((issue) => issue.reason === "low-self-score"));
});

test("freeForm prompts switch to creative mode without evidence anchors", () => {
  const trafficMeta = TREND_BUCKET_META.find((item) => item.key === "traffic");
  const systemPrompt = buildTrendAnalysisSystemPrompt(
    [trafficMeta],
    { trendCount: 10, profileType: "brand", freeForm: true },
  );
  assert.match(systemPrompt, /创意假设模式/);
  assert.match(systemPrompt, /创意槽位/);
  assert.match(systemPrompt, /自评分/);
  assert.match(systemPrompt, /TREND_SELF_SCORE_MIN|70/);
  assert.doesNotMatch(systemPrompt, /必须先从对应来源标题中逐字保留/);
  assert.doesNotMatch(systemPrompt, /网页事实片段/);

  const userPrompt = buildTrendAnalysisUserPrompt(
    brand,
    { freeForm: true, trendCount: 10 },
    [trafficMeta],
  );
  assert.match(userPrompt, /创意假设模式/);
  assert.match(userPrompt, /创意槽位计划/);
  assert.doesNotMatch(userPrompt, /如果搜索结果不足/);
  assert.doesNotMatch(userPrompt, /AnySearch\/Pgy 证据为准/);
});

test("freeForm validation skips unsupported-hard-claim and stale-window gates", () => {
  const normalized = normalizeTrendSet([{
    title: "折叠桌面灯分区补光讨论升温",
    category: "内容机会",
    market_change: "用户从固定台灯讨论转向折叠便携补光",
    consumer_shift: "租房人群更在意桌面收纳与移动补光",
    why_now: "近期讨论集中在小空间线材冲突",
    brand_opportunity: "LightMate 可展示折叠灯归位动作",
    content_direction: "做桌面摆位前后对照组图",
    summary: "用户从固定台灯讨论转向折叠便携补光；租房人群更在意桌面收纳与移动补光",
    reason: "折叠桌面灯分区补光讨论升温，可做成小空间补光清单并自然带入品牌收纳动作。",
    score: 78,
    novelty_score: 80,
    brand_fit_score: 85,
    actionability_score: 76,
    tags: ["#折叠灯", "#桌面补光", "#小空间"],
    ideas: [
      {
        title: "租房桌面折叠灯摆位对照",
        summary: "展示拥挤桌面到折叠归位的前后对比，说明小空间补光怎么收。",
        angle: "前后对照 + 收纳动作",
        brandFit: "用 LightMate 折叠灯完成归位演示",
        audience: "租房居家办公人群",
        hook: "桌面太挤了，灯还能这样收？",
        tags: ["#租房改造", "#桌面收纳", "#补光"],
      },
      {
        title: "分区补光任务清单",
        summary: "按键盘区屏幕区分区补光，讲清便携灯怎么跟着任务移动。",
        angle: "任务清单 + 分区场景",
        brandFit: "把折叠灯放进居家办公任务流",
        audience: "居家办公租房党",
        hook: "补光不是越亮越好，分区才重要",
        tags: ["#居家办公", "#分区补光", "#折叠灯"],
      },
    ],
  }], brand, 100);

  const hardItem = {
    ...normalized[0],
    summary: "该话题互动量高，热度持续上升，销量增长 20%。",
  };
  const items = Array.from({ length: 10 }, (_, index) => ({
    ...normalized[0],
    title: `${normalized[0].title}${index}`,
    stableKey: `freeform-${index}`,
    ...(index === 0 ? hardItem : {}),
  }));
  const bucket = [{ key: "traffic", title: "流量", description: "", items }];
  const meta = [TREND_BUCKET_META.find((item) => item.key === "traffic")];

  const strictIssues = getTrendGenerationIssues(bucket, meta, null, brand, null);
  assert.ok(strictIssues.some((issue) => issue.reason === "unsupported-hard-claim"));

  const freeFormIssues = getTrendGenerationIssues(
    bucket,
    meta,
    null,
    brand,
    null,
    new Date(),
    { freeForm: true },
  );
  assert.equal(freeFormIssues.some((issue) => issue.reason === "unsupported-hard-claim"), false);
});

test("freeForm validation flags theme clusters shared by three or more titles", () => {
  const normalized = normalizeTrendSet([{
    title: "折叠桌面灯分区补光讨论",
    category: "内容机会",
    market_change: "用户从固定台灯讨论转向折叠便携补光",
    consumer_shift: "租房人群更在意桌面收纳与移动补光",
    why_now: "近期讨论集中在小空间线材冲突",
    brand_opportunity: "LightMate 可展示折叠灯归位动作",
    content_direction: "做桌面摆位前后对照组图",
    summary: "用户从固定台灯讨论转向折叠便携补光",
    reason: "折叠桌面灯分区补光讨论升温，可做成小空间补光清单并自然带入品牌收纳动作。",
    score: 78,
    novelty_score: 80,
    brand_fit_score: 85,
    actionability_score: 76,
    tags: ["#折叠灯", "#桌面补光", "#小空间"],
    ideas: [
      {
        title: "租房桌面折叠灯摆位对照",
        summary: "展示拥挤桌面到折叠归位的前后对比。",
        angle: "前后对照 + 收纳动作",
        brandFit: "用 LightMate 折叠灯完成归位演示",
        audience: "租房居家办公人群",
        hook: "桌面太挤了，灯还能这样收？",
        tags: ["#租房改造", "#桌面收纳", "#补光"],
      },
      {
        title: "分区补光任务清单",
        summary: "按键盘区屏幕区分区补光。",
        angle: "任务清单 + 分区场景",
        brandFit: "把折叠灯放进居家办公任务流",
        audience: "居家办公租房党",
        hook: "补光不是越亮越好，分区才重要",
        tags: ["#居家办公", "#分区补光", "#折叠灯"],
      },
    ],
  }], brand, 100);

  const clusteredTitles = [
    "更好人生故事征集：记录你的奋斗瞬间",
    "更好人生直播圆桌：探讨职场女性的成长",
    "更好人生观点辩论：奋斗与生活的平衡",
    "深夜独居的治愈仪式",
    "办公室下午茶品质指南",
    "周末聚会待客之道",
    "独居女性的深夜充电",
    "职场女性的早晨仪式",
    "从纪录片到餐桌的叙事链路",
    "成分党如何辨别牛奶品质",
  ];
  const items = clusteredTitles.map((title, index) => ({
    ...normalized[0],
    title,
    stableKey: `cluster-${index}`,
  }));
  const bucket = [{ key: "traffic", title: "流量", description: "", items }];
  const meta = [TREND_BUCKET_META.find((item) => item.key === "traffic")];

  const issues = getTrendGenerationIssues(
    bucket,
    meta,
    null,
    brand,
    null,
    new Date(),
    { freeForm: true },
  );
  const clusterIssues = issues.filter((issue) => issue.reason === "theme-cluster");
  assert.ok(clusterIssues.length >= 1, "three titles sharing a 4-char phrase must be flagged");
  assert.ok(clusterIssues.every((issue) => ["更好人生", "职场女性"].includes(issue.claim)));

  const nonFreeFormIssues = getTrendGenerationIssues(bucket, meta, null, brand, null);
  assert.equal(
    nonFreeFormIssues.some((issue) => issue.reason === "theme-cluster"),
    false,
    "theme-cluster gate must only apply in freeForm mode",
  );
});
