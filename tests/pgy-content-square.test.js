const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPgyHotNotesPayload,
  DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
  fetchPgyXhsHotNotes,
  isPgyCategoryPathInTree,
  normalizeCookieHeader,
  normalizePgyCategoryPath,
  normalizePgyCategoryTree,
  normalizePgyHotNotes,
  parseCookieTokenText,
  redactSensitiveText,
} = require("../src/server/integrations/pgy-content-square");
const {
  buildPgyEvidencePromptBlock,
  buildTrendAnalysisSystemPrompt,
  buildTrendAnalysisUserPrompt,
  buildXhsCategoryPromptBlock,
  PGY_XHS_TREND_COUNT,
  TREND_BUCKET_META,
} = require("../src/server/ai/trend-service");

const brand = {
  id: 1,
  name: "RedBase",
  industry: "美妆",
  audience: "25-35 岁都市女性",
  description: "关注高效护肤和生活方式表达。",
  product: "精华与面霜",
  goal: "提升小红书种草内容质量",
  knowledgeBase: "",
  assetTags: ["护肤", "内容运营"],
};

const appConfig = {
  pgy: {
    enabled: true,
    cookie: "web_session=secret",
    userAgent: "test-agent",
    timeoutMs: 1000,
  },
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("normalizes Pgy category paths from UI and tree values", () => {
  assert.equal(normalizePgyCategoryPath("内容类目"), "");
  assert.equal(normalizePgyCategoryPath("美妆/护肤"), "内容类目#美妆#护肤");
  assert.equal(normalizePgyCategoryPath("美妆 > 护肤"), "内容类目#美妆#护肤");
  assert.equal(normalizePgyCategoryPath("护肤", "内容类目#美妆"), "内容类目#美妆#护肤");
  assert.equal(normalizePgyCategoryPath("内容类目#美妆#护肤"), "内容类目#美妆#护肤");
});

test("normalizes Pgy category tree and validates selected paths", () => {
  const tree = normalizePgyCategoryTree([
    {
      itemName: "内容类目",
      itemValue: "内容类目",
      children: [
        {
          itemName: "美妆",
          itemValue: "美妆",
          children: [{ itemName: "护肤", itemValue: "护肤" }],
        },
      ],
    },
  ]);

  assert.deepEqual(tree, {
    root: "内容类目",
    items: [
      {
        label: "美妆",
        value: "内容类目#美妆",
        children: [{ label: "护肤", value: "内容类目#美妆#护肤" }],
      },
    ],
  });
  assert.equal(isPgyCategoryPathInTree("美妆/护肤", tree), true);
  assert.equal(isPgyCategoryPathInTree("旅行/酒店", tree), false);
});

test("builds Pgy hot note payload with category and exposure sort", () => {
  const payload = buildPgyHotNotesPayload({
    categoryPath: "美妆/护肤",
    pageSize: "20",
    pageNum: "2",
    nd: "7",
  });

  assert.equal(payload.noteContentCategory, "内容类目#美妆#护肤");
  assert.equal(payload.pageSize, 20);
  assert.equal(payload.pageNum, 2);
  assert.equal(payload.nd, "7");
  assert.equal(payload.orderBy, "premium_imp_num");
  assert.equal(payload.sort, "desc");
  assert.equal(buildPgyHotNotesPayload().pageSize, DEFAULT_PGY_HOT_NOTES_PAGE_SIZE);
  assert.equal(DEFAULT_PGY_HOT_NOTES_PAGE_SIZE, 10);
});

test("normalizes Pgy hot notes into prompt-safe evidence", () => {
  const notes = normalizePgyHotNotes(
    [
      {
        noteInfo: {
          noteId: "abc123",
          title: "  早C晚A新手攻略  ",
          noteType: 1,
          noteImages: [{ imageUrl: "http://image.example/cover.jpg" }],
          readNum: 12000,
          likeNum: 300,
          favNum: 80,
          cmtNum: 12,
        },
        userInfo: {
          nickName: "护肤博主",
          fansNum: 15000,
        },
      },
    ],
    "美妆/护肤",
  );

  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "早C晚A新手攻略");
  assert.equal(notes[0].categoryPath, "内容类目#美妆#护肤");
  assert.equal(notes[0].noteUrl, "https://www.xiaohongshu.com/explore/abc123");
  assert.equal(notes[0].primaryCoverUrl, "https://image.example/cover.jpg");
  assert.equal(notes[0].metrics.engagementCount, 392);
});

test("Pgy fetch returns typed empty-result errors", async () => {
  await assert.rejects(
    fetchPgyXhsHotNotes(appConfig, {
      fetchImpl: async () => jsonResponse({ code: 0, success: true, data: { noteList: [] } }),
    }),
    { code: "PGY_EMPTY_RESULT" },
  );
});

test("Pgy error messages redact cookie and token-like values", async () => {
  assert.equal(redactSensitiveText("cookie=abc token:def xsec_token=secret"), "cookie=[redacted] token:[redacted] xsec_token=[redacted]");
  await assert.rejects(
    fetchPgyXhsHotNotes(appConfig, {
      fetchImpl: async () => jsonResponse({ code: 400, success: false, msg: "token=abc cookie=def sign=ghi" }),
    }),
    (error) => {
      assert.equal(error.code, "PGY_API_ERROR");
      assert.doesNotMatch(error.message, /abc|def|ghi/);
      return true;
    },
  );
});

test("parses bug.py style token files into cookie headers", () => {
  assert.equal(
    normalizeCookieHeader({ web_session: "session-a", "access-token-pgy.xiaohongshu.com": "token-a" }),
    "web_session=session-a; access-token-pgy.xiaohongshu.com=token-a",
  );
  assert.equal(
    parseCookieTokenText('{"web_session":"session-a","x-user-id-pgy.xiaohongshu.com":"user-a"}\n{"web_session":"session-b"}'),
    "web_session=session-a; x-user-id-pgy.xiaohongshu.com=user-a",
  );
  assert.equal(parseCookieTokenText("web_session=session-a; a1=a1-value"), "web_session=session-a; a1=a1-value");
});

test("includes Pgy evidence and category constraints in trend prompts", () => {
  const evidence = {
    categoryPath: "美妆/护肤",
    notes: [
      {
        exposureRank: 1,
        title: "早C晚A新手攻略",
        noteType: "image",
        primaryCoverUrl: "https://image.example/cover.jpg",
        metrics: {
          readCount: 12000,
          likeCount: 300,
          favoriteCount: 80,
          commentCount: 12,
        },
        author: {
          nickname: "护肤博主",
          fansCount: 15000,
        },
      },
    ],
  };

  const evidenceBlock = buildPgyEvidencePromptBlock(evidence);
  assert.match(evidenceBlock, /Pgy 小红书热门证据/);
  assert.match(evidenceBlock, /类目：内容类目#美妆#护肤/);
  assert.match(evidenceBlock, /早C晚A新手攻略/);
  assert.match(evidenceBlock, /阅读：1\.2万/);
  assert.match(evidenceBlock, /赞藏评：300\/80\/12/);

  const prompt = buildTrendAnalysisUserPrompt(brand, { pgyEvidence: evidence });
  assert.match(prompt, /小红书热点话题 bucket 必须严格输出 10 条/);
  assert.match(prompt, /不要直接复制 Pgy 原帖标题做 trend\.title/);
  assert.match(prompt, /不要在 trend\.summary、reason、ideas 或任何字段里输出小红书链接/);
  assert.match(prompt, /trend\.summary 必须由 AI 总结/);
  assert.match(prompt, /早C晚A新手攻略/);

  const categoryOnlyPrompt = buildTrendAnalysisUserPrompt(brand, { xhsCategoryPath: "美妆/护肤" });
  assert.match(categoryOnlyPrompt, /小红书内容类目限定/);
  assert.match(categoryOnlyPrompt, /Pgy 内容类目路径：内容类目#美妆#护肤/);
  assert.match(categoryOnlyPrompt, /跨类目热点只有在能自然服务该类目时才保留/);
  assert.equal(buildXhsCategoryPromptBlock("内容类目"), "");
});

test("trend prompts only include the selected bucket rules", () => {
  const trafficBucket = TREND_BUCKET_META.find((bucket) => bucket.key === "traffic");
  const prompt = [
    buildTrendAnalysisSystemPrompt([trafficBucket]),
    buildTrendAnalysisUserPrompt(brand, {}, [trafficBucket]),
  ].join("\n");

  assert.match(prompt, /bucket 标题：流量热点趋势/);
  assert.match(prompt, /bucket 描述：从小红书站内爆款形式/);
  assert.match(prompt, /只分析内容形式、标题结构、封面表达、组图结构、爆款套路和互动机制/);
  assert.doesNotMatch(prompt, /bucket 标题：小红书热点话题/);
  assert.doesNotMatch(prompt, /bucket 标题：新闻热点趋势/);
  assert.doesNotMatch(prompt, /只基于 Pgy 小红书热门证据和品牌档案/);
  assert.doesNotMatch(prompt, /只分析近期事件、行业动态、政策变化、消费新闻/);
});
