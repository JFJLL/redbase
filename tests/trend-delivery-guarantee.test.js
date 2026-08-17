const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDeterministicEvidenceSlots,
  buildRerankedEvidencePlan,
  resolveRerankAppConfig,
} = require("../src/server/ai/trend-evidence-reranker");
const {
  generateAiTrendSet,
  buildAnySearchGenerationPlan,
  getXhsPgyDeliveryIssues,
} = require("../src/server/ai/trend-service");
const { clearAnySearchCache } = require("../src/server/integrations/anysearch");

const brand = {
  id: 1,
  name: "LightMate",
  industry: "家居照明",
  audience: "租房与居家办公人群",
  description: "小空间便携照明",
  product: "折叠桌面灯",
  goal: "发现近期内容机会",
  knowledgeBase: "不宣称治疗或预防近视",
  assetTags: ["租房友好", "桌面美学"],
};

const fixedNow = new Date("2026-07-17T04:00:00.000Z");

function markdownFixture() {
  return [
    "## Query 1: general one",
    "### 1. 护眼消费趋势",
    "- **URL**: https://www.ce.cn/trend-a",
    "- Author: 编辑 Published: 2026-07-16 Source: ce.cn LightMate 折叠桌面灯消费者更关注舒适用光。",
    "## Query 2: general two",
    "### 1. 行业内容方向",
    "- **URL**: https://www.xinhuanet.com/trend-b",
    "- Published: 2026-07-15 Source: xinhuanet.com 家居照明的便携与小空间成为讨论场景。",
    "## Query 4: social",
    "### 1. 微博用户讨论",
    "- **URL**: https://m.weibo.cn/status/123",
    "- Source: weibo.com 用户讨论桌面拥挤与移动照明。",
    "## Query 5: social",
    "### 1. 知乎用户讨论",
    "- **URL**: https://www.zhihu.com/question/456",
    "- Source: zhihu.com 用户讨论租房照明。",
  ].join("\n");
}

function completeContentAssets(label) {
  return {
    moments: {
      title: `${label}朋友圈配图`,
      caption: `${label}从小空间桌面的真实使用出发，整理照明、收纳和移动使用时值得关注的细节。`,
      visualDirection: "小空间桌面与折叠灯的真实使用画面",
    },
    xhsCarousel: {
      title: `${label}小红书组图`,
      publishTitle: `${label}桌面照明检查清单`,
      publishCaption: `${label}整理小空间桌面照明的选择思路，从照明区域、折叠收纳和移动场景逐项判断。`,
      caption: `${label}四页组图说明桌面照明选择逻辑。`,
      slides: [1, 2, 3, 4].map((index) => ({
        pageLabel: `第 ${index} 张`,
        title: `${label}检查项 ${index}`,
        copy: `${label}第 ${index} 个检查项说明实际使用条件。`,
        visualDirection: `${label}小桌面使用场景 ${index}`,
      })),
    },
    wechatLongImage: {
      title: `${label}公众号长图`,
      publishTitle: `${label}小空间桌面照明怎么选`,
      intro: `${label}围绕有限桌面空间，建立照明区域、收纳方式和移动使用的判断框架。`,
      outline: [`${label}判断照明区域`, `${label}比较收纳方式`, `${label}核对移动场景`],
      positioning: `${label}帮助小空间用户建立桌面照明选择框架。`,
      cta: `${label}保存清单，布置桌面前逐项核对。`,
      visualDirection: `${label}桌面照明选择框架长图。`,
    },
  };
}

// Same shape as the anysearch-integration fixture builder: ten distinct,
// evidence-grounded cards that pass the full validation pipeline.
function generatedTrendBatch(prefix, options = {}) {
  const bucketKey = options.bucketKey || "traffic";
  const category = options.category || "流量趋势";
  const evidenceIds = options.evidenceIds || ["S1"];
  const topic = options.topic || "折叠桌面灯的舒适用光与小空间照明选择";
  const brandName = "LightMate";
  const product = "折叠桌面灯";
  const audience = "桌面空间有限的租房与居家办公人群";
  const variants = [
    { title: "小桌面摆位", focus: "灯具占位、照明边界与常用物品动线", outcome: "先量出可用区域再安排灯位", routes: ["尺寸核对清单", "摆位前后对照"] },
    { title: "租房搬家收纳", focus: "临时住所里的折叠收纳与跨房间移动", outcome: "减少搬动和收纳时的反复取舍", routes: ["搬家收纳步骤", "多房间移动记录"] },
    { title: "居家办公补光", focus: "长时间办公时键盘区、屏幕区与纸面区的用光分配", outcome: "按任务划分局部补光范围", routes: ["办公任务分区", "一天光线复盘"] },
    { title: "视频会议布光", focus: "线上会议中面部、背景与桌面的光线关系", outcome: "用有限空间改善镜头画面层次", routes: ["镜头布光检查", "会议画面对比"] },
    { title: "夜间阅读区域", focus: "夜读时书页、手写区与周边环境的亮度关系", outcome: "找到不打扰同住者的阅读位置", routes: ["夜读位置测试", "共居使用约定"] },
    { title: "共享桌面切换", focus: "多人轮换使用同一张桌面时的快速复位需求", outcome: "建立拿取、展开和归位顺序", routes: ["桌面切换流程", "家庭成员实测"] },
    { title: "宿舍床边照明", focus: "床边学习、取物与熄灯后的便携照明需求", outcome: "兼顾有限插座和随手收纳", routes: ["床边动线清单", "晚间使用日记"] },
    { title: "手账拍摄补光", focus: "手账、静物和细节拍摄时的阴影与反光控制", outcome: "用简单位置变化改善拍摄呈现", routes: ["拍摄阴影排查", "同物多角度实验"] },
    { title: "狭窄角落布置", focus: "墙角、窗边和窄柜旁难以固定灯位的问题", outcome: "从折叠半径和取电位置判断可用性", routes: ["角落条件测量", "取电路线规划"] },
    { title: "桌搭线材整理", focus: "照明设备与充电线、键鼠线共同占用桌面的冲突", outcome: "把收线和照明调整纳入同一套整理流程", routes: ["线材冲突排查", "每周桌搭维护"] },
  ];
  return {
    trendBuckets: [{
      key: bucketKey,
      items: Array.from({ length: 10 }, (_, index) => {
        const label = `${prefix}${index + 1}`;
        const variant = variants[index];
        return {
          stableKey: `${bucketKey}-${prefix}-${index + 1}`,
          title: `${label}：${variant.title}｜${topic}`,
          category,
          market_change: `${label}内容场正从泛照明种草转向围绕${variant.focus}的具体过程拆解。`,
          consumer_shift: `${audience}更在意${variant.focus}，而不只是灯具外观。`,
          why_now: `当前讨论已落到${variant.title}的可执行步骤，适合立刻做成内容。`,
          brand_opportunity: `${brandName}可用${product}进入${variant.title}场景，帮助用户${variant.outcome}。`,
          content_direction: `围绕${variant.title}输出${variant.routes.join("与")}，把${topic}做成可跟做内容。`,
          confidence_score: 89 - index,
          summary: `${label}围绕${topic}，重点拆解${variant.focus}，帮助${audience}${variant.outcome}。`,
          score: 89 - index,
          tags: ["#桌面照明", "#租房布置", "#居家办公"],
          reason: `${label}基于“${topic}”这一来源话题，适合用“${variant.title}”的实际过程呈现 ${brandName} 的${product}，让${audience}看到${variant.outcome}的判断依据。`,
          evidenceIds,
          ideas: variant.routes.map((routeName, routeIndex) => ({
            title: `${label}${routeIndex === 0 ? "A" : "B"}：${routeName}`,
            summary: `以${variant.focus}为主线，把${topic}转成${routeName}，给出可观察的过程与行动信息。`,
            angle: routeIndex === 0 ? `从${variant.title}前的条件核对切入。` : `从${variant.title}后的实际变化切入。`,
            brandFit: `${brandName}可在${variant.title}的操作过程中展示${product}如何被拿取、调整和归位。`,
            audience,
            hook: `${variant.title}最容易忽略的条件是什么？`,
            tags: [`#${variant.title}`, "#真实场景", "#品牌运营"],
            contentAssets: completeContentAssets(`${label}${routeIndex === 0 ? "A" : "B"}`),
          })),
        };
      }),
    }],
  };
}

test("XHS Pgy delivery accepts lean ideas without content assets", () => {
  const buckets = generatedTrendBatch("轻量趋势", { bucketKey: "xhs" }).trendBuckets.map((bucket) => ({
    ...bucket,
    items: bucket.items.map((item) => ({
      ...item,
      ideas: item.ideas.map((idea) => ({ ...idea, contentAssets: {} })),
    })),
  }));

  const issues = getXhsPgyDeliveryIssues(buckets, brand);
  assert.doesNotMatch(JSON.stringify(issues), /missing-content-assets/);
});

function mixedCandidateFixture() {
  return [
    { id: "C1", title: "LightMate 折叠桌面灯用户口碑讨论", snippet: "用户讨论便携照明与桌面收纳。", sourceType: "web", trustLevel: "medium", trustScore: 3, queryIndex: 0, brandRelevant: true, trafficRelevant: true, url: "https://www.ce.cn/a", host: "ce.cn", publishedAt: "2026-07-16" },
    { id: "C2", title: "家居照明小空间内容趋势", snippet: "家居照明与租房场景内容形式。", sourceType: "web", trustLevel: "medium", trustScore: 3, queryIndex: 1, brandRelevant: true, trafficRelevant: true, url: "https://www.xinhuanet.com/b", host: "xinhuanet.com", publishedAt: "2026-07-15" },
    { id: "C3", title: "篮球联赛最新比分", snippet: "球队排名和球员转会。", sourceType: "web", trustLevel: "low", trustScore: 1, queryIndex: 2, brandRelevant: false, trafficRelevant: false, url: "https://www.sohu.com/c", host: "sohu.com", publishedAt: "2026-07-14" },
    { id: "C4", title: "钢铁价格走势", snippet: "钢材出口和期货价格。", sourceType: "web", trustLevel: "low", trustScore: 1, queryIndex: 3, brandRelevant: false, trafficRelevant: false, url: "https://www.163.com/d", host: "163.com", publishedAt: "2026-07-13" },
  ];
}

test("deterministic slots never pick completely irrelevant candidates while relevant ones exist", () => {
  const slots = buildDeterministicEvidenceSlots(mixedCandidateFixture(), brand, "news", 10);
  assert.equal(slots.length, 10);
  const usedIds = new Set(slots.map((slot) => slot.evidenceIds[0]));
  assert.deepEqual([...usedIds].sort(), ["C1", "C2"]);
  assert.ok(slots.every((slot) => slot.topic && slot.brandLink && Array.isArray(slot.avoidClaims)));
  // Only 2 relevant candidates: reused sources must split into distinct
  // scene/content-form slots — all ten topics stay unique.
  assert.equal(new Set(slots.map((slot) => slot.topic)).size, 10);
});

test("a reused-source fallback carries a slot-reuse warning alongside unique topics", async () => {
  const searchEvidence = { evidence: [], candidates: mixedCandidateFixture() };
  const plan = await buildRerankedEvidencePlan({ textProvider: {} }, brand, [{ key: "news", title: "新闻热点趋势" }], searchEvidence, {
    trendCount: 10,
    textModelImpl: async () => {
      throw new Error("rerank model unavailable");
    },
  });
  assert.equal(plan.slots.length, 10);
  assert.equal(new Set(plan.slots.map((slot) => slot.topic)).size, 10);
  assert.ok(plan.warnings.some((warning) => warning.code === "EVIDENCE_SLOT_REUSED"));
});

test("rerank model failure degrades to deterministic slots with a warning and keeps going", async () => {
  const searchEvidence = { evidence: [], candidates: mixedCandidateFixture() };
  const plan = await buildRerankedEvidencePlan({ textProvider: {} }, brand, [{ key: "news", title: "新闻热点趋势" }], searchEvidence, {
    trendCount: 10,
    textModelImpl: async () => {
      throw new Error("rerank model unavailable");
    },
  });
  assert.equal(plan.usedModel, false);
  assert.ok(plan.warnings.some((warning) => warning.code === "EVIDENCE_RERANK_FALLBACK"));
  assert.equal(plan.slots.length, 10);
  // Final evidence is re-numbered S1.. and excludes the irrelevant candidates.
  assert.deepEqual(plan.evidence.map((item) => item.id), ["S1", "S2"]);
  assert.ok(plan.evidence.every((item) => !/篮球|钢铁/.test(item.title)));
});

test("model rerank output is validated, deduplicated, and mapped to S evidence ids", async () => {
  const searchEvidence = { evidence: [], candidates: mixedCandidateFixture() };
  const plan = await buildRerankedEvidencePlan({ textProvider: {} }, brand, [{ key: "track", title: "赛道热点趋势" }], searchEvidence, {
    trendCount: 10,
    textModelImpl: async () => ({
      slots: [
        { candidateId: "C2", topic: "家居照明小空间", bucketFit: 90, brandFit: 85, brandLink: "从小空间照明切入", allowedClaims: ["小空间照明被讨论"], avoidClaims: ["销量领先"] },
        { candidateId: "C2", topic: "家居照明小空间", bucketFit: 90, brandFit: 85 },
        { candidateId: "C1", topic: "LightMate 用户口碑", bucketFit: 80, brandFit: 92 },
        { candidateId: "C9", topic: "不存在的候选" },
      ],
    }),
  });
  assert.equal(plan.usedModel, true);
  // Duplicate topic + unknown candidate are dropped.
  assert.equal(plan.slots.length, 2);
  assert.deepEqual(plan.evidence.map((item) => item.id), ["S1", "S2"]);
  assert.deepEqual(plan.slots.map((slot) => slot.evidenceIds[0]), ["S1", "S2"]);
  assert.deepEqual(plan.slots[0].allowedClaims, ["小空间照明被讨论"]);
});

test("TREND_RERANK_MODEL overrides the model only for rerank calls and falls back when unset", () => {
  const withOverride = resolveRerankAppConfig({ textProvider: { model: "main-model", rerankModel: "cheap-model" } });
  assert.equal(withOverride.textProvider.model, "cheap-model");
  const withoutOverride = { textProvider: { model: "main-model", rerankModel: "" } };
  assert.equal(resolveRerankAppConfig(withoutOverride), withoutOverride);
});

test("a real but completely irrelevant candidate picked by the rerank model is dropped", async () => {
  const searchEvidence = { evidence: [], candidates: mixedCandidateFixture() };
  const plan = await buildRerankedEvidencePlan({ textProvider: {} }, brand, [{ key: "news", title: "新闻热点趋势" }], searchEvidence, {
    trendCount: 10,
    textModelImpl: async () => ({
      slots: [
        { candidateId: "C1", topic: "LightMate 用户口碑", bucketFit: 90, brandFit: 92 },
        // C3 exists in the candidate pool but is brandRelevant=false and
        // trafficRelevant=false — the model must not resurrect it.
        { candidateId: "C3", topic: "篮球联赛最新比分", bucketFit: 88, brandFit: 80 },
      ],
    }),
  });
  assert.equal(plan.usedModel, true);
  assert.equal(plan.slots.length, 1);
  assert.deepEqual(plan.evidence.map((item) => item.id), ["S1"]);
  assert.ok(plan.evidence.every((item) => !/篮球|钢铁/.test(item.title)));
});

test("a first-call transport failure with evidence degrades to lightweight trends", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  const result = await generateAiTrendSet({
    searchProvider: { enabled: true, socialEnabled: true, minReliableEvidence: 1, urlCheckEnabled: false, cacheTtlMs: 0 },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7800, {
    bucketKey: "news",
    anySearchOptions: { now: fixedNow, requestImpl: async () => markdownFixture() },
    textModelImpl: async () => {
      modelCalls += 1;
      const error = new Error("connect ETIMEDOUT upstream");
      error.code = "ETIMEDOUT";
      throw error;
    },
  });

  // 趋势阶段只交付轻量趋势；模型失败时用证据槽位维持页面可用，
  // 后续生图再按需补齐 contentAssets。
  assert.equal(modelCalls, 1);
  assert.equal(result[0].items.length, 10);
  assert.ok(result.analysisWarnings.some((warning) => warning.code === "TREND_MODEL_UNAVAILABLE"));
  assert.ok(result[0].items.every((item) =>
    item.ideas.every((idea) => Object.keys(idea.contentAssets || {}).length === 0),
  ));
});

test("freeForm rejects a partial batch when the model cannot produce ten trends", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  await assert.rejects(generateAiTrendSet({
    trendAnalysis: { freeForm: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7900, {
    bucketKey: "traffic",
    textModelImpl: async (_config, request) => {
      modelCalls += 1;
      if (modelCalls === 2) {
        assert.match(request.systemPrompt, /本次不要输出 contentAssets/);
        assert.match(request.userPrompt, /本次不要输出 contentAssets/);
        assert.doesNotMatch(request.systemPrompt, /contentAssets 必须包含 moments、xhsCarousel、wechatLongImage/);
        assert.doesNotMatch(request.userPrompt, /contentAssets 必须包含 moments、xhsCarousel、wechatLongImage/);
      }
      const batch = generatedTrendBatch("部分批", { bucketKey: "traffic" });
      for (const item of batch.trendBuckets[0].items) {
        item.ideas = item.ideas.map(({ contentAssets: _contentAssets, ...idea }) => idea);
      }
      return { trendBuckets: [{ key: "traffic", items: batch.trendBuckets[0].items.slice(0, 8) }] };
    },
    maxAiCalls: 2,
  }), { code: "TREND_AI_CALL_BUDGET_EXCEEDED" });
  assert.equal(modelCalls, 2);
});

test("freeForm strips model-provided content assets from ten complete visible ideas", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  const result = await generateAiTrendSet({
    trendAnalysis: { freeForm: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7902, {
    bucketKey: "traffic",
    textModelImpl: async (_config, request) => {
      modelCalls += 1;
      assert.match(request.systemPrompt, /本次不要输出 contentAssets/);
      assert.doesNotMatch(request.systemPrompt, /contentAssets 必须包含 moments、xhsCarousel、wechatLongImage/);
      const batch = generatedTrendBatch("轻量批", { bucketKey: "traffic" });
      const distinctTitles = [
        "租房小桌测量与灯位清单",
        "搬家灯具折叠收纳记录",
        "居家办公任务分区补光",
        "视频会议镜头层次调整",
        "夜间阅读位置测试方法",
        "家庭共享空间复位流程",
        "宿舍床边取物照明日记",
        "手账拍摄阴影排查步骤",
        "墙角窗边取电路线规划",
        "线材灯位共同整理顺序",
      ];
      for (const [index, item] of batch.trendBuckets[0].items.entries()) {
        item.title = distinctTitles[index];
      }
      return batch;
    },
    maxAiCalls: 2,
  });

  assert.equal(modelCalls, 1);
  assert.equal(result[0].items.length, 10);
  // 即使模型越界返回完整资产，freeForm 也只持久化外显字段。
  assert.ok(result[0].items.every((item) =>
    item.ideas.length === 2 && item.ideas.every((idea) => Object.keys(idea.contentAssets || {}).length === 0)));
});

test("freeForm accepts ten complete visible ideas when the model omits content assets", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  const result = await generateAiTrendSet({
    trendAnalysis: { freeForm: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7903, {
    bucketKey: "traffic",
    textModelImpl: async () => {
      modelCalls += 1;
      const batch = generatedTrendBatch("无资产轻量批", { bucketKey: "traffic" });
      const titles = [
        "租房小桌测量与灯位清单",
        "搬家灯具折叠收纳记录",
        "居家办公任务分区补光",
        "视频会议镜头层次调整",
        "夜间阅读位置测试方法",
        "家庭共享空间复位流程",
        "宿舍床边取物照明日记",
        "手账拍摄阴影排查步骤",
        "墙角窗边取电路线规划",
        "线材灯位共同整理顺序",
      ];
      for (const [index, item] of batch.trendBuckets[0].items.entries()) {
        item.title = titles[index];
        item.ideas = item.ideas.map(({ contentAssets: _contentAssets, ...idea }) => idea);
      }
      return batch;
    },
    maxAiCalls: 2,
  });

  assert.equal(modelCalls, 1);
  assert.equal(result[0].items.length, 10);
  assert.ok(result[0].items.every((item) =>
    item.ideas.length === 2 && item.ideas.every((idea) => Object.keys(idea.contentAssets || {}).length === 0)));
});

test("model-only mode skips AnySearch even when the provider is enabled", async () => {
  clearAnySearchCache();
  let searchCalls = 0;
  let modelCalls = 0;
  const distinctTitles = [
    "租房小桌测量与灯位清单",
    "搬家灯具折叠收纳记录",
    "居家办公任务分区补光",
    "视频会议镜头层次调整",
    "夜间阅读位置测试方法",
    "家庭共享空间复位流程",
    "宿舍床边取物照明日记",
    "手账拍摄阴影排查步骤",
    "墙角窗边取电路线规划",
    "线材灯位共同整理顺序",
  ];
  const result = await generateAiTrendSet({
    trendAnalysis: { freeForm: true },
    searchProvider: { enabled: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7904, {
    bucketKey: "traffic",
    anySearchOptions: {
      requestImpl: async () => {
        searchCalls += 1;
        throw new Error("AnySearch must not be called in model-only mode");
      },
    },
    textModelImpl: async (_config, request) => {
      modelCalls += 1;
      assert.equal(request.useSearch, false);
      const batch = generatedTrendBatch("模型直生成", { bucketKey: "traffic" });
      for (const [index, item] of batch.trendBuckets[0].items.entries()) {
        item.title = distinctTitles[index];
      }
      return batch;
    },
  });

  assert.equal(searchCalls, 0);
  assert.equal(modelCalls, 1);
  assert.equal(result[0].items.length, 10);
  assert.deepEqual(result.analysisWarnings, []);
});

test("model-only mode rejects invalid output instead of locally degrading it", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  await assert.rejects(generateAiTrendSet({
    trendAnalysis: { freeForm: true },
    searchProvider: { enabled: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7906, {
    bucketKey: "traffic",
    textModelImpl: async () => {
      modelCalls += 1;
      const batch = generatedTrendBatch("不合格模型输出", { bucketKey: "traffic" });
      batch.trendBuckets[0].items[0].ideas[0].hook = "";
      return batch;
    },
    maxAiCalls: 5,
  }), { code: "TREND_MODEL_VALIDATION_FAILED" });
  assert.equal(modelCalls, 3);
});

test("freeForm rejects a short batch containing skeleton items", async () => {
  clearAnySearchCache();
  await assert.rejects(generateAiTrendSet({
    trendAnalysis: { freeForm: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7905, {
    bucketKey: "traffic",
    textModelImpl: async () => {
      const batch = generatedTrendBatch("骨架批", { bucketKey: "traffic" });
      const items = batch.trendBuckets[0].items;
      for (const item of items) {
        item.ideas = item.ideas.map(({ contentAssets: _contentAssets, ...idea }) => idea);
      }
      // 6 条完整 + 2 条骨架（无 ideas）不能被当作成功交付。
      const skeletons = items.slice(6, 8).map((item) => ({ ...item, ideas: [] }));
      return { trendBuckets: [{ key: "traffic", items: [...items.slice(0, 6), ...skeletons] }] };
    },
    maxAiCalls: 2,
  }), { code: "TREND_AI_CALL_BUDGET_EXCEEDED" });
});

test("freeForm soft-filters low self-scores instead of failing the batch", async () => {
  clearAnySearchCache();
  const result = await generateAiTrendSet({
    trendAnalysis: { freeForm: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7910, {
    bucketKey: "traffic",
    textModelImpl: async () => {
      const batch = generatedTrendBatch("软分批", { bucketKey: "traffic" });
      const distinctTitles = [
        "租房小桌测量与灯位清单",
        "搬家灯具折叠收纳记录",
        "居家办公任务分区补光",
        "视频会议镜头层次调整",
        "夜间阅读位置测试方法",
        "家庭共享空间复位流程",
        "宿舍床边取物照明日记",
        "手账拍摄阴影排查步骤",
        "墙角窗边取电路线规划",
        "线材灯位共同整理顺序",
      ];
      for (const [index, item] of batch.trendBuckets[0].items.entries()) {
        item.title = distinctTitles[index];
      }
      batch.trendBuckets[0].items = batch.trendBuckets[0].items.map((item) => ({
        ...item,
        novelty_score: 65,
        brand_fit_score: 66,
        actionability_score: 67,
      }));
      return batch;
    },
    maxAiCalls: 2,
  });
  assert.equal(result[0].items.length, 10);
});

test("generation plan lines carry rerank slot anchors and claim boundaries", () => {
  const plan = buildAnySearchGenerationPlan({
    evidence: [
      { id: "S1", title: "LightMate 折叠桌面灯用户口碑讨论", snippet: "讨论" },
      { id: "S2", title: "家居照明小空间内容趋势", snippet: "讨论" },
    ],
    rerankSlots: [
      { evidenceIds: ["S2"], topic: "家居照明小空间", brandLink: "从小空间照明切入", allowedClaims: ["小空间照明被讨论"], avoidClaims: ["销量领先"] },
      { evidenceIds: ["S1"], topic: "LightMate 用户口碑", brandLink: "从口碑话题切入", allowedClaims: [], avoidClaims: [] },
    ],
  }, 2, false);
  assert.match(plan, /1\. stableKey 必须为 "slot-01"；evidenceIds 必须恰好为 \["S2"\]/);
  assert.match(plan, /话题锚点：家居照明小空间/);
  assert.match(plan, /可支撑表述：小红书?|小空间照明被讨论/);
  assert.match(plan, /2\. stableKey 必须为 "slot-02"；evidenceIds 必须恰好为 \["S1"\]/);
});

test("all six buckets deliver exactly ten items when sources exist", async () => {
  for (const bucketKey of ["traffic", "news", "social", "track", "crowd"]) {
    clearAnySearchCache();
    const result = await generateAiTrendSet({
      searchProvider: { enabled: true, socialEnabled: true, minReliableEvidence: 1, urlCheckEnabled: false, cacheTtlMs: 0 },
      textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
    }, brand, 7100, {
      bucketKey,
      anySearchOptions: { now: fixedNow, requestImpl: async () => markdownFixture() },
      textModelImpl: async () => generatedTrendBatch(`${bucketKey}批`, { bucketKey }),
    });
    assert.equal(result.length, 1, bucketKey);
    assert.equal(result[0].key, bucketKey);
    assert.equal(result[0].items.length, 10, bucketKey);
  }

  const pgyEvidence = {
    categoryPath: "家居家装 / 家居用品",
    notes: Array.from({ length: 10 }, (_, index) => ({
      exposureRank: index + 1,
      title: `折叠桌面灯小空间照明方向${index + 1}`,
      noteType: "normal",
      metrics: {},
      author: {},
    })),
  };
  const xhsResult = await generateAiTrendSet({
    searchProvider: { enabled: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7200, {
    bucketKey: "xhs",
    pgyEvidence,
    textModelImpl: async () => generatedTrendBatch("xhs批", { bucketKey: "xhs", category: "小红书热点", evidenceIds: [] }),
  });
  assert.equal(xhsResult[0].key, "xhs");
  assert.equal(xhsResult[0].items.length, 10);
});

test("seven valid cards stay untouched while only the three bad cards enter the repair request", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  const repairCounts = [];
  const result = await generateAiTrendSet({
    searchProvider: { enabled: true, socialEnabled: true, minReliableEvidence: 1, urlCheckEnabled: false, cacheTtlMs: 0 },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7300, {
    bucketKey: "traffic",
    anySearchOptions: { now: fixedNow, requestImpl: async () => markdownFixture() },
    textModelImpl: async (_config, request) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        const batch = generatedTrendBatch("首轮", { bucketKey: "traffic" });
        for (const index of [1, 4, 7]) {
          batch.trendBuckets[0].items[index].ideas[0].tags = [];
        }
        return batch;
      }
      const countMatch = request.userPrompt.match(/必须按数组顺序返回 (\d+) 条/);
      repairCounts.push(Number(countMatch?.[1] || 0));
      const repaired = generatedTrendBatch("首轮", { bucketKey: "traffic" });
      return { items: [1, 4, 7].map((index) => repaired.trendBuckets[0].items[index]) };
    },
  });

  assert.equal(modelCalls, 2);
  assert.deepEqual(repairCounts, [3]);
  assert.equal(result[0].items.length, 10);
  assert.deepEqual(result.analysisWarnings, []);
});

test("a repair-model outage still returns ten items with warnings", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  const result = await generateAiTrendSet({
    searchProvider: { enabled: true, socialEnabled: true, minReliableEvidence: 1, urlCheckEnabled: false, cacheTtlMs: 0 },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7400, {
    bucketKey: "traffic",
    anySearchOptions: { now: fixedNow, requestImpl: async () => markdownFixture() },
    textModelImpl: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        const batch = generatedTrendBatch("修复故障", { bucketKey: "traffic" });
        for (const index of [1, 4, 7]) {
          batch.trendBuckets[0].items[index].ideas[0].tags = [];
        }
        return batch;
      }
      throw new Error("repair model unavailable");
    },
  });

  assert.equal(modelCalls, 2);
  assert.equal(result[0].items.length, 10);
  assert.equal(
    result.analysisWarnings.filter((warning) => warning.code === "TREND_ITEM_DEGRADED").length,
    3,
  );
  assert.ok(result[0].items.every((item) => item.ideas.every((idea) => idea.tags.length >= 3)));
});

test("one duplicate card cannot sink the other nine", async () => {
  clearAnySearchCache();
  let modelCalls = 0;
  const makeDuplicateBatch = () => {
    const batch = generatedTrendBatch("重复场景", { bucketKey: "track", category: "赛道趋势" });
    batch.trendBuckets[0].items[9].title = batch.trendBuckets[0].items[0].title;
    return batch;
  };
  const result = await generateAiTrendSet({
    searchProvider: { enabled: true, socialEnabled: true, minReliableEvidence: 1, urlCheckEnabled: false, cacheTtlMs: 0 },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7500, {
    bucketKey: "track",
    anySearchOptions: { now: fixedNow, requestImpl: async () => markdownFixture() },
    textModelImpl: async () => {
      modelCalls += 1;
      if (modelCalls === 1) return makeDuplicateBatch();
      return { items: [makeDuplicateBatch().trendBuckets[0].items[9]] };
    },
  });

  assert.equal(modelCalls, 2);
  assert.equal(result[0].items.length, 10);
  assert.ok(result.analysisWarnings.some((warning) => warning.code === "TREND_ITEM_DEGRADED"));
});

test("a short xhs model batch tops up with lightweight Pgy cards", async () => {
  let modelCalls = 0;
  const pgyEvidence = {
    categoryPath: "家居家装 / 家居用品",
    notes: Array.from({ length: 10 }, (_, index) => ({
      exposureRank: index + 1,
      title: `折叠桌面灯小空间照明方向${index + 1}`,
      summary: `站内讨论方向${index + 1}`,
      noteType: "normal",
      metrics: {},
      author: {},
    })),
  };
  const result = await generateAiTrendSet({
    searchProvider: { enabled: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7600, {
    bucketKey: "xhs",
    pgyEvidence,
    textModelImpl: async () => {
      modelCalls += 1;
      const batch = generatedTrendBatch("短批", { bucketKey: "xhs", category: "小红书热点", evidenceIds: [] });
      batch.trendBuckets[0].items = batch.trendBuckets[0].items.slice(0, 4);
      return batch;
    },
  });

  // Pgy 补齐卡只负责趋势页的轻量字段；完整内容资产在用户生图时按需生成。
  assert.equal(modelCalls, 1);
  assert.equal(result[0].items.length, 10);
  assert.ok(result.analysisWarnings.some((warning) => warning.code === "TREND_ITEM_FALLBACK"));
  assert.ok(result[0].items.every((item) =>
    item.ideas.every((idea) => Object.keys(idea.contentAssets || {}).length === 0),
  ));
});

test("a fully unparsable xhs model response uses lightweight Pgy cards", async () => {
  let modelCalls = 0;
  const pgyEvidence = {
    categoryPath: "家居家装 / 家居用品",
    notes: Array.from({ length: 10 }, (_, index) => ({
      exposureRank: index + 1,
      title: `折叠桌面灯小空间照明方向${index + 1}`,
      summary: `站内讨论方向${index + 1}`,
      noteType: "normal",
      metrics: {},
      author: {},
    })),
  };
  const result = await generateAiTrendSet({
    searchProvider: { enabled: true },
    textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
  }, brand, 7700, {
    bucketKey: "xhs",
    pgyEvidence,
    textModelImpl: async () => {
      modelCalls += 1;
      return ["sorry", "no json"];
    },
  });

  assert.equal(modelCalls, 1);
  assert.equal(result[0].items.length, 10);
  assert.ok(result.analysisWarnings.some((warning) => warning.code === "TREND_ITEM_FALLBACK"));
  assert.ok(result[0].items.every((item) =>
    item.ideas.every((idea) => Object.keys(idea.contentAssets || {}).length === 0),
  ));
});
