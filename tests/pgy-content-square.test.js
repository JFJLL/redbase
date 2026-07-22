const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  buildPgyHotNotesPayload,
  DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
  fetchPgyXhsHotNotes,
  isPgyCategoryPathInTree,
  normalizeCookieHeader,
  normalizePgyCategoryPath,
  normalizePgyCategoryTree,
  normalizePgyHotNotes,
  parseCookieTokenList,
  parseCookieTokenText,
  redactSensitiveText,
} = require("../src/server/integrations/pgy-content-square");
const {
  buildIdeaRegenerationSystemPrompt,
  buildIdeaRegenerationUserPrompt,
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

test("builds excellent-content Pgy payload with engagement sort overrides", () => {
  const payload = buildPgyHotNotesPayload({
    categoryPath: "美妆/护肤",
    pageSize: 20,
    pageNum: 1,
    nd: "7",
    orderBy: "premium_engage_num",
    sort: "desc",
  });
  assert.equal(payload.orderBy, "premium_engage_num");
  assert.equal(payload.nd, "7");
  assert.equal(payload.sort, "desc");
  assert.equal(payload.pageSize, 20);
  assert.equal(payload.pageNum, 1);
  assert.equal(payload.noteContentCategory, "内容类目#美妆#护肤");
  // Default trend behavior remains exposure sort.
  assert.equal(buildPgyHotNotesPayload().orderBy, "premium_imp_num");
  assert.equal(buildPgyHotNotesPayload().nd, "3");
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
  assert.equal(notes[0].noteId, "abc123");
  assert.equal(typeof notes[0].noteId, "string");
  assert.equal(notes[0].id, "abc123");
  assert.deepEqual(notes[0].imageUrls, ["https://image.example/cover.jpg"]);
  assert.equal(notes[0].noteType, "image");
  assert.equal(notes[0].sourceKey, "xhs_hot");
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
  assert.deepEqual(parseCookieTokenList('{"web_session":"session-a"}\n{"web_session":"session-b"}'), ["web_session=session-a", "web_session=session-b"]);
  assert.equal(
    parseCookieTokenText('{"web_session":"session-a","x-user-id-pgy.xiaohongshu.com":"user-a"}\n{"web_session":"session-b"}'),
    "web_session=session-a; x-user-id-pgy.xiaohongshu.com=user-a",
  );
  assert.equal(parseCookieTokenText("web_session=session-a; a1=a1-value"), "web_session=session-a; a1=a1-value");
});

test("rotates Pgy cookie pool after an auth failure", async () => {
  const cookiesSeen = [];
  const result = await fetchPgyXhsHotNotes(
    {
      pgy: {
        enabled: true,
        cookie: '{"web_session":"expired"}\n{"web_session":"fresh"}',
        userAgent: "test-agent",
        timeoutMs: 1000,
      },
    },
    {
      fetchImpl: async (url, options) => {
        cookiesSeen.push(options.headers.cookie);
        if (cookiesSeen.length === 1) {
          return jsonResponse({ code: 401, success: false, msg: "login expired" }, 401);
        }
        return jsonResponse({
          code: 0,
          success: true,
          data: {
            noteList: [
              {
                noteInfo: {
                  title: "fresh cookie note",
                  noteImages: [{ imageUrl: "https://image.example/fresh.jpg" }],
                },
              },
            ],
          },
        });
      },
    },
  );

  assert.deepEqual(cookiesSeen, ["web_session=expired", "web_session=fresh"]);
  assert.equal(result.notes[0].title, "fresh cookie note");
});

test("prefers OSS cookie text over local cookie file and refreshes local cache", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "redbase-pgy-"));
  const cookieFile = path.join(tmpDir, "token.txt");
  await fs.writeFile(cookieFile, '{"web_session":"stale"}\n', "utf8");

  const cookiesSeen = [];
  const result = await fetchPgyXhsHotNotes(
    {
      pgy: {
        enabled: true,
        cookieFile,
        userAgent: "test-agent",
        timeoutMs: 1000,
        ossEndpoint: "https://oss-cn-beijing.aliyuncs.com",
        ossBucket: "redmagic",
        ossObjectKey: "KOL/token.txt",
        ossAccessKeyId: "access-key",
        ossAccessKeySecret: "access-secret",
      },
    },
    {
      fetchImpl: async (url, options) => {
        if (url.includes("oss-cn-beijing")) {
          return {
            ok: true,
            status: 200,
            text: async () => '{"web_session":"fresh"}\n',
          };
        }
        cookiesSeen.push(options.headers.cookie);
        return jsonResponse({
          code: 0,
          success: true,
          data: {
            noteList: [
              {
                noteInfo: {
                  title: "oss fresh note",
                  noteImages: [{ imageUrl: "https://image.example/oss.jpg" }],
                },
              },
            ],
          },
        });
      },
    },
  );

  assert.deepEqual(cookiesSeen, ["web_session=fresh"]);
  assert.equal(result.notes[0].title, "oss fresh note");
  assert.equal(await fs.readFile(cookieFile, "utf8"), '{"web_session":"fresh"}\n');
});

test("retries transient Pgy network failures with the cookie pool", async () => {
  const cookiesSeen = [];
  const result = await fetchPgyXhsHotNotes(
    {
      pgy: {
        enabled: true,
        cookie: "web_session=single",
        userAgent: "test-agent",
        timeoutMs: 1000,
      },
    },
    {
      fetchImpl: async (url, options) => {
        cookiesSeen.push(options.headers.cookie);
        if (cookiesSeen.length === 1) {
          throw new Error("fetch failed");
        }
        return jsonResponse({
          code: 0,
          success: true,
          data: {
            noteList: [
              {
                noteInfo: {
                  title: "retried note",
                  noteImages: [{ imageUrl: "https://image.example/retry.jpg" }],
                },
              },
            ],
          },
        });
      },
    },
  );

  assert.deepEqual(cookiesSeen, ["web_session=single", "web_session=single"]);
  assert.equal(result.notes[0].title, "retried note");
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
  assert.match(prompt, /十条趋势必须使用不同的主路线、用户场景和 idea 执行动作/);
  assert.match(prompt, /不得输出“旧话题复燃”“长尾稳定”“品牌可用但非热点”/);
  assert.match(prompt, /Pgy 证据只代表本次传入的热门笔记信号/);
  assert.match(prompt, /健康、儿童、药品、医疗和政策内容不得给答案、建议、疗效/);
  assert.doesNotMatch(prompt, /小红书文案结尾去模板化/);
  assert.doesNotMatch(prompt, /publishCaption 可以使用评论区引导/);

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
  assert.match(prompt, /bucket 描述：从可核验的内容形式、标题结构、场景表达和互动设计中找到流量机会/);
  assert.match(prompt, /只分析证据中可观察的内容形式、标题结构、封面表达、组图结构和互动机制/);
  assert.match(prompt, /idea\[0\] 走「内容形式借鉴」/);
  assert.match(prompt, /idea\[1\] 走「互动话题反差」/);
  assert.match(prompt, /AnySearch 证据时，必须使用传入的 S 编号/);
  assert.doesNotMatch(prompt, /bucket 标题：小红书热点话题/);
  assert.doesNotMatch(prompt, /bucket 标题：新闻热点趋势/);
  assert.doesNotMatch(prompt, /只基于 Pgy 小红书热门证据和品牌档案/);
  assert.doesNotMatch(prompt, /只分析近期事件、行业动态、政策变化、消费新闻/);
  assert.doesNotMatch(prompt, /idea\[0\] 走「热点证据解读」/);
});

test("idea regeneration prompts keep two ideas on separate routes", () => {
  const trackBucket = TREND_BUCKET_META.find((bucket) => bucket.key === "track");
  const prompt = buildIdeaRegenerationSystemPrompt([trackBucket]);

  assert.match(prompt, /idea\[0\] 走「品类决策科普」/);
  assert.match(prompt, /idea\[1\] 走「痛点对比避坑」/);
  assert.match(prompt, /禁止只做同义改写/);
  assert.match(prompt, /不同的用户场景、叙事切口和执行步骤/);
  assert.match(prompt, /track\/crowd\/xhs 类选题必须给出具体用户场景、人群颗粒度和产品自然植入方式/);
  assert.match(prompt, /避免使用“数据证明”“权威认证”“最新政策明确”“销量领先”/);
  assert.match(prompt, /高风险趋势如果不能合规转化/);
  assert.match(prompt, /不要所有文案都以提问或评论区 CTA 收尾/);
  assert.doesNotMatch(prompt, /idea\[0\] 走「爆款形式复用」/);
});

test("idea regeneration user prompts include freshness and risk boundaries", () => {
  const prompt = buildIdeaRegenerationUserPrompt(
    brand,
    {
      title: "儿童护理热点",
      category: "大健康",
      summary: "围绕近期家长关注的日常护理内容。",
      reason: "品牌可从合规科普角度进入。",
    },
    "减少敏感风险",
  );

  assert.match(prompt, /不要输出“旧话题复燃”“长尾稳定”“品牌可用但非热点”/);
  assert.match(prompt, /不能声称已核验正文、真实销量、医学结论或站外排名/);
  assert.match(prompt, /不得输出诊断、治疗、用药建议、功效承诺或煽动性立场/);
  assert.match(prompt, /不要批量使用“评论区分享一下”“评论区聊聊”“你怎么看”/);
  assert.match(prompt, /减少敏感风险/);
});
