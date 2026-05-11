const { clampScore, normalizeTags, sanitizeIdea } = require("../utils");
const { callTextModelJson } = require("./text-provider");
const { normalizeIdeaContentAssets, hasCompleteIdeaContentAssets } = require("./content-service");
const {
  DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
  fetchPgyXhsHotNotes,
  getPgyPublicErrorMessage,
  normalizePgyCategoryPath,
} = require("../integrations/pgy-content-square");

const PGY_XHS_TREND_COUNT = DEFAULT_PGY_HOT_NOTES_PAGE_SIZE;
const TREND_ITEMS_PER_BUCKET = 10;
const MIN_TREND_ITEMS_PER_BUCKET = 1;

const IDEA_ROUTE_PAIRS = {
  xhs: ["热点证据解读", "用户场景转化"],
  traffic: ["爆款形式复用", "互动话题反差"],
  news: ["信息解释提醒", "生活应用清单"],
  social: ["情绪共鸣表达", "具体场景行动"],
  track: ["品类决策科普", "痛点对比避坑"],
  crowd: ["身份共鸣洞察", "具体场景解决"],
};

const TREND_BUCKET_META = [
  {
    key: "xhs",
    title: "小红书热点话题",
    description: "从小红书站内高讨论、高收藏、高互动内容里筛选可被品牌借势的话题方向。",
    promptDescription: "聚焦小红书站内高讨论、高收藏、高互动、易被笔记化的话题方向。",
    promptRules: [
      "只基于 Pgy 小红书热门证据和品牌档案判断站内热门笔记背后的话题机会。",
      "本 bucket 不启用 google_search；不要引用搜索结果、新闻网页或站外热榜。",
      "每条趋势要从 Pgy 热门内容里提炼用户需求、内容钩子和品牌可自然进入的角度。",
    ],
  },
  {
    key: "traffic",
    title: "流量热点趋势",
    description: "从小红书站内爆款形式、标题结构、场景表达和内容套路中找到流量机会。",
    promptDescription: "聚焦小红书站内正在被大量模仿、搜索、转发或评论的内容形式、标题结构、场景表达和爆款笔记套路。",
    promptRules: [
      "只分析内容形式、标题结构、封面表达、组图结构、爆款套路和互动机制。",
      "不要输出具体话题热词本身，除非它用于说明一种可复用的内容形式。",
      "每条趋势都要能直接转化为品牌内容的表达方法或版式方法。",
    ],
  },
  {
    key: "news",
    title: "新闻热点趋势",
    description: "从近期新闻、行业动态和消费趋势中找到可被品牌内容化的机会。",
    promptDescription: "聚焦近期事件、行业动态、政策/消费新闻中可内容化的机会。",
    promptRules: [
      "只分析近期事件、行业动态、政策变化、消费新闻中可被内容化的机会。",
      "不要编造具体日期、机构、排名或数据；不确定时表达为趋势方向或议题方向。",
      "每条趋势要说明品牌如何合规、自然地借势，而不是硬蹭新闻。",
    ],
  },
  {
    key: "social",
    title: "社会热点趋势",
    description: "从大众情绪、生活方式变化、社会议题和公共讨论中找到适合品牌表达的切口。",
    promptDescription: "聚焦大众情绪、生活方式变化、节日节点和公共讨论中适合品牌表达的切口。",
    promptRules: [
      "只分析大众情绪、生活方式变化、节日节点、公共讨论和社会心理变化。",
      "避免敏感立场、争议煽动和绝对化价值判断。",
      "每条趋势要落到品牌能表达的情绪价值、生活场景或用户关系。",
    ],
  },
  {
    key: "track",
    title: "赛道热点趋势",
    description: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
    promptDescription: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
    promptRules: [
      "只分析品牌所属品类、竞品表达、产品卖点、用户购买决策和赛道增长机会。",
      "不要泛化到无关行业；所有趋势都必须能回到当前品牌的产品或服务。",
      "每条趋势要体现品类洞察、消费理由或决策阻力。",
    ],
  },
  {
    key: "crowd",
    title: "人群热点趋势",
    description: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
    promptDescription: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
    promptRules: [
      "只分析目标用户身份、痛点、场景、焦虑、兴趣圈层和内容需求。",
      "不要把用户写成泛人群；每条趋势都要对应一个清晰人群或具体使用场景。",
      "每条趋势要能指导品牌说什么、对谁说、在什么场景说。",
    ],
  },
];

function normalizePromptBucketMeta(bucketMeta = TREND_BUCKET_META[0]) {
  const source = Array.isArray(bucketMeta) ? bucketMeta : [bucketMeta];
  const validBuckets = source.filter((bucket) => bucket && typeof bucket === "object");
  return validBuckets.length ? [validBuckets[0]] : [TREND_BUCKET_META[0]];
}

function formatBucketKeys(bucketMeta) {
  return normalizePromptBucketMeta(bucketMeta).map((bucket) => bucket.key).join("、");
}

function formatBucketTitles(bucketMeta) {
  return normalizePromptBucketMeta(bucketMeta).map((bucket) => bucket.title).join("、");
}

function formatBucketPromptRules(bucketMeta) {
  return normalizePromptBucketMeta(bucketMeta)
    .map((bucket) =>
      [
        `bucket 标题：${bucket.title}`,
        `bucket 描述：${bucket.description || bucket.promptDescription || ""}`,
        "bucket 规则：",
        ...(bucket.promptRules || []).map((rule, index) => `${index + 1}. ${rule}`),
      ].join("\n"),
    )
    .join("\n\n");
}

function getIdeaRoutePair(bucketMeta) {
  const [bucket] = normalizePromptBucketMeta(bucketMeta);
  return IDEA_ROUTE_PAIRS[bucket.key] || ["理性实用路线", "场景共鸣路线"];
}

function buildIdeaDiversityPrompt(bucketMeta) {
  const [firstRoute, secondRoute] = getIdeaRoutePair(bucketMeta);
  return [
    `同一 trend 下的 2 条 idea 必须是两个明显不同的内容选择：idea[0] 走「${firstRoute}」，idea[1] 走「${secondRoute}」。`,
    "两条 idea 禁止只做同义改写；title、summary、angle、audience、hook 至少有 3 项明显不同。",
    "两条 idea 还必须覆盖不同的用户场景、内容形式和执行动作，不要只是换一组形容词或换一个标题。",
    "禁止连续复用相同标题结构、相同人群泛称、相同封面钩子或相同组图逻辑。",
    "两条 idea 的 contentAssets 必须分别沿用各自路线，不要复用同一套朋友圈文案、小红书文案、组图页标题或公众号导语。",
  ].join("\n");
}

function buildTrendDeduplicationPrompt() {
  return [
    "跨趋势去重规则：同一批 10 条 trend 之间，title、summary、reason、ideas.angle、ideas.audience、ideas.hook 不能高度相似。",
    "如果多个证据指向相似热点，不要换标题重复输出；必须拆成不同用户需求、不同内容形式或不同消费场景，否则合并并改写为新的差异化方向。",
    "禁止把同一热点、同一人群、同一痛点或同一产品卖点换一种说法后重复生成。",
  ].join("\n");
}

function buildTrendFreshnessPrompt() {
  return [
    "新颖度与时效判断：每条 trend 必须区分自己属于近期爆发、旧话题复燃、长尾稳定、品牌可用但非热点中的哪一种，并在 summary 或 reason 中体现判断。",
    "如果只是历史长期复用内容，只能表达为长尾稳定或旧话题复燃，不能包装成近期新热点。",
    "summary 和 reason 必须说明为什么现在值得做；如果只是稳定长尾机会，要明确说明它适合持续内容而不是快速蹭热点。",
  ].join("\n");
}

function buildEvidenceBoundaryPrompt() {
  return [
    "数据来源与可信边界：Pgy bucket 只能引用已传入的标题、阅读、赞藏评、作者信息，不能声称已核验正文、真实销量、医学结论或站外排名。",
    "搜索增强 bucket 只能表达趋势方向或议题方向，不输出未验证的具体机构、日期、排名、数值或确定性事实。",
    "选题里避免使用“数据证明”“权威认证”“最新政策明确”“销量领先”等无法由输入证据支持的表述。",
  ].join("\n");
}

function buildSensitiveRiskPrompt() {
  return [
    "敏感风险过滤：健康、儿童、药品、医疗、政策、社会争议类内容不得输出诊断、治疗、用药建议、功效承诺或煽动性立场。",
    "如果品牌属于大健康、母婴、药品、医疗或功效型赛道，默认转为生活方式、日常护理、合规科普、就医提醒边界，不给专业诊疗结论。",
    "高风险趋势如果不能合规转化，score 必须降到 60 以下，并在 reason 中说明不建议优先选择。",
  ].join("\n");
}

function buildBucketSpecificHardeningPrompt(bucketMeta) {
  const [bucket] = normalizePromptBucketMeta(bucketMeta);
  if (!["track", "crowd", "xhs"].includes(bucket.key)) return "";
  return [
    "当前 bucket 额外要求：",
    "track/crowd/xhs 类选题必须给出具体用户场景、人群颗粒度和产品自然植入方式。",
    "不要只写“宝妈、年轻人、目标用户、关注健康的人”这类泛人群；必须写清楚谁在什么情境下为什么需要这个内容。",
  ].join("\n");
}

function buildRichIdeaRequirementsPrompt() {
  return [
    "每条 idea 都要按“完整内容选题卡”输出，不要写成一句话骨架。",
    "idea.title：16-32 个中文字符，要像可直接发布或派给运营执行的小红书选题标题。",
    "idea.summary：70-120 个中文字符，说明内容要讲什么、为什么用户会关心、预期解决什么问题。",
    "idea.angle：35-70 个中文字符，写清楚具体切入方式，避免只写“科普”“种草”“场景化”这类短标签。",
    "idea.brandFit：60-110 个中文字符，写清楚品牌如何自然进入内容，必须包含产品/服务卖点、使用场景或信任理由。",
    "idea.audience：20-50 个中文字符，描述具体人群和场景，不要只写泛泛的“宝妈”“年轻人”“目标用户”。",
    "idea.hook：25-60 个中文字符，必须是可直接放到开头的第一句话或封面钩子，要有情绪、问题或具体场景。",
    "contentAssets.moments.caption：80-140 个中文字符，像真实朋友圈文案，不要只写一句口号。",
    "contentAssets.xhsCarousel.publishCaption：100-180 个中文字符，像真实小红书发布文案，要有场景、价值点和轻互动。",
  ].join("\n");
}

function buildTrendAnalysisSystemPrompt(bucketMeta = [TREND_BUCKET_META[0]]) {
  const selectedBucketMeta = normalizePromptBucketMeta(bucketMeta);
  return [
    "你是资深小红书内容运营策略顾问，擅长品牌定位、热点适配判断与内容选题策划。",
    "你的任务是根据完整品牌档案和当前 bucket 证据，一次性输出热点趋势、选题和每个选题的完整 contentAssets。",
    "所有趋势都要优先判断其在小红书上的讨论价值、内容扩散潜力、用户搜索/收藏/互动意愿和品牌适配度，不要写成泛泛的全网热点报告。",
    "请只输出 JSON，不要输出 Markdown，不要补充解释。",
    'JSON 顶层结构必须是：{"trendBuckets":[...]}。',
    `trendBuckets 只输出当前请求的 ${selectedBucketMeta.length} 个对象，key 分别是 ${formatBucketKeys(selectedBucketMeta)}；不要额外生成其他 bucket，也不要输出任何品牌摘要字段。`,
    "当前 bucket 独立规则：",
    formatBucketPromptRules(selectedBucketMeta),
    "每个 bucket 必须包含：key, title, description, items。",
    `每个 items 输出 ${TREND_ITEMS_PER_BUCKET} 条 trend。`,
    "每条 trend 必须包含：id 或 stableKey、title, category, summary, score, tags, reason, ideas。",
    "score 必须是 0 到 100 的整数，代表热度指数。",
    "热度指数评分标准：90-100 为爆发级热点，站内讨论强、内容供给增长快、品牌借势窗口短；80-89 为高潜热点，搜索/互动趋势明显，适合快速布局；70-79 为稳定热点，有持续内容需求，适合做系列化内容；60-69 为长尾热点，适合垂直人群或细分场景；60 以下为弱热点，除非品牌强相关，否则不建议优先选择。",
    "评分时综合考虑：小红书站内讨论度、搜索意图、互动/收藏潜力、内容可复制性、目标人群相关性、品牌自然植入度和近期时效性。不要编造具体播放量、搜索量、排名或机构数据。",
    "tags 必须是 3 到 5 个以 # 开头的字符串。",
    "ideas 必须是 2 条，每条 idea 必须包含：title, summary, angle, brandFit, audience, hook, tags, contentAssets。",
    buildIdeaDiversityPrompt(selectedBucketMeta),
    buildTrendDeduplicationPrompt(),
    buildTrendFreshnessPrompt(),
    buildEvidenceBoundaryPrompt(),
    buildSensitiveRiskPrompt(),
    buildBucketSpecificHardeningPrompt(selectedBucketMeta),
    buildRichIdeaRequirementsPrompt(),
    "contentAssets 必须在本次同一个 JSON 里完整生成；这是内容选题页可展示、后续可生图的完整内容资产包，不只是生图 prompt。",
    buildContentAssetsSchemaPrompt(),
    "所有字段都用中文输出，允许品牌名保留原文。",
  ].join("\n");
}

function formatMetric(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0";
  if (numeric >= 10000) return `${(numeric / 10000).toFixed(numeric >= 100000 ? 0 : 1)}万`;
  return String(Math.round(numeric));
}

function buildPgyEvidencePromptBlock(pgyEvidence) {
  const notes = Array.isArray(pgyEvidence?.notes) ? pgyEvidence.notes.slice(0, PGY_XHS_TREND_COUNT) : [];
  if (!notes.length) return "";
  const categoryPath = normalizePgyCategoryPath(pgyEvidence.categoryPath || "") || "全部内容类目";
  const rows = notes.map((note) => {
    const metrics = note.metrics || {};
    const author = note.author || {};
    return [
      `${note.exposureRank}. 标题：${note.title || "无标题"}`,
      `类型：${note.noteType === "video" ? "视频" : "图文"}`,
      `阅读：${formatMetric(metrics.readCount)}`,
      `赞藏评：${formatMetric(metrics.likeCount)}/${formatMetric(metrics.favoriteCount)}/${formatMetric(metrics.commentCount)}`,
      `作者：${author.nickname || "未知"}（粉丝 ${formatMetric(author.fansCount)}）`,
    ].join(" | ");
  });

  return [
    "小红书热点话题 bucket 的 Pgy 小红书热门证据：",
    `类目：${categoryPath || "全部内容类目"}；排序：近3日曝光量降序；数据源：Pgy Content Square / 小红书热门。`,
    ...rows,
    "",
    `小红书热点话题 bucket 必须严格输出 ${TREND_ITEMS_PER_BUCKET} 条，每条按上方 Pgy 证据 1-${TREND_ITEMS_PER_BUCKET} 的顺序一一对应。`,
    "不要直接复制 Pgy 原帖标题做 trend.title；请把原帖归纳成干净、短句化、可读性强的趋势标题。",
    "不要在 trend.summary、reason、ideas 或任何字段里输出小红书链接、原帖 URL、封面 URL、noteId 或原始接口字段。",
    "trend.summary 必须由 AI 总结：同时说明这个 Pgy 热门内容背后的用户需求、内容钩子，以及它和当前品牌的自然关系。",
    "每条 trend 的 2 条 ideas 必须由 AI 生成，并且都要同时挂钩 Pgy 热点和当前品牌；不要使用模板化的“拆解/改写”硬编码表达。",
    "如果 Pgy 原帖本身和品牌距离较远，也要提炼出可借势的消费场景、情绪、生活方式或内容结构，再判断品牌如何自然进入。",
    "如果多条 Pgy 原帖属于同一类老话题或相似内容形式，必须拆出不同用户需求、不同内容形式或不同消费场景，不要重复生成相同趋势。",
    "Pgy 证据只代表本次传入的热门笔记信号，不能扩展为已核验正文、真实销量、医学结论或站外排名。",
    "不要编造 Pgy 未返回的曝光量、排名外数据或笔记正文；本次不要生成其他 bucket。",
  ].join("\n");
}

function buildXhsCategoryPromptBlock(categoryPath) {
  const normalizedCategoryPath = normalizePgyCategoryPath(categoryPath);
  if (!normalizedCategoryPath) return "";
  return [
    "小红书内容类目限定：",
    `本次分析选择的 Pgy 内容类目路径：${normalizedCategoryPath}。`,
    "小红书热点话题 bucket 需要优先围绕该类目里的热门笔记、话题表达、视觉形式和用户互动语境生成；跨类目热点只有在能自然服务该类目时才保留。",
  ].join("\n");
}

function buildTrendAnalysisUserPrompt(brand, options = {}, bucketMeta = [TREND_BUCKET_META[0]]) {
  const selectedBucketMeta = normalizePromptBucketMeta(bucketMeta);
  const pgyEvidenceBlock = buildPgyEvidencePromptBlock(options.pgyEvidence);
  const categoryBlock = buildXhsCategoryPromptBlock(options.xhsCategoryPath || options.pgyEvidence?.categoryPath || "");
  const strictLines = options.strict
    ? [
        `重要：必须返回 trendBuckets，且 ${formatBucketKeys(selectedBucketMeta)} ${selectedBucketMeta.length} 个当前 bucket 的 items 都不能为空。`,
        "每条 trend 必须有 2 条 idea，且每条 idea 必须有完整 contentAssets。",
        "如果搜索结果不足，请基于可验证的趋势方向表达，不要编造具体机构、日期或数据。",
        "只返回 JSON 对象，不要解释失败原因，不要输出自然语言说明。",
      ]
    : [];
  return [
    `请基于以下品牌信息，围绕小红书平台的热点话题与内容机会，只为用户当前点击的维度生成热点趋势、选题和完整内容资产包。`,
    "",
    "当前 bucket 独立规则：",
    formatBucketPromptRules(selectedBucketMeta),
    "",
    `品牌名称：${brand.name}`,
    `行业：${brand.industry}`,
    `目标受众：${brand.audience}`,
    `品牌介绍：${brand.description}`,
    `产品/服务：${brand.product}`,
    `运营目标：${brand.goal}`,
    `品牌资料库：${brand.knowledgeBase || "暂无补充资料"}`,
    `品牌资产标签：${(brand.assetTags || []).join("、") || "暂无"}`,
    ...(categoryBlock && !pgyEvidenceBlock ? ["", categoryBlock] : []),
    ...(pgyEvidenceBlock ? ["", pgyEvidenceBlock] : []),
    "",
    "要求：",
    `1. 当前只生成这个维度：${formatBucketTitles(selectedBucketMeta)}；不要输出任何其他 bucket。`,
    `2. 每个当前维度输出 ${TREND_ITEMS_PER_BUCKET} 条趋势，共 ${selectedBucketMeta.length * TREND_ITEMS_PER_BUCKET} 条。`,
    "3. 趋势名称要像真实小红书内容方向，而不是宏观行业报告标题。",
    "4. 每条趋势都要解释为什么适合该品牌，尤其说明它和品牌、人群、内容场景之间的自然连接。",
    "5. score 要严格按热度指数评分标准给出，不要所有趋势都给高分；优先把 80 分以上留给真正具备快速借势价值的趋势。",
    "6. 选题要能直接给运营同学使用，标题、角度、钩子都要有小红书笔记感，避免空泛文案。",
    buildRichIdeaRequirementsPrompt(),
    "7. 每条趋势固定生成 2 条 idea，每条 idea 必须同步生成完整 contentAssets，并遵守两条选题差异规则，不能只返回选题骨架或同义改写。",
    "8. contentAssets 要包含内容选题页可直接展示的文案和后续生图需要的中文视觉方向；不要输出 style、composition、prompt，系统会自动生成生图 prompt。",
    "9. 不要输出品牌摘要字段；不要在 contentAssets 里补充品牌档案没有依据的固定行业样例。",
    "10. 如果涉及新闻、社会议题或近期热点，请表达为可验证的趋势或议题方向，不要编造具体机构、日期、排名或数据。",
    "11. 不要输出固定行业样例，不要在提示词里写与当前品牌无关的早餐、牛奶、儿童用药等具体场景；只有品牌档案、趋势或选题自然需要时才出现。",
    `12. ${buildTrendDeduplicationPrompt()}`,
    `13. ${buildTrendFreshnessPrompt()}`,
    `14. ${buildEvidenceBoundaryPrompt()}`,
    `15. ${buildSensitiveRiskPrompt()}`,
    buildBucketSpecificHardeningPrompt(selectedBucketMeta),
    ...strictLines,
  ].join("\n");
}

function buildIdeaRegenerationSystemPrompt(bucketMeta = [TREND_BUCKET_META[0]]) {
  const selectedBucketMeta = normalizePromptBucketMeta(bucketMeta);
  return [
    "你是一名小红书内容策划专家，擅长把品牌资产与热点趋势组合成可执行选题。",
    "请只输出 JSON，不要输出 Markdown，不要补充解释。",
    'JSON 顶层结构必须是：{"ideas":[...]}。',
    "ideas 必须输出 2 条。",
    "每条 idea 必须包含：title, summary, angle, brandFit, audience, hook, tags, contentAssets。",
    buildIdeaDiversityPrompt(selectedBucketMeta),
    buildEvidenceBoundaryPrompt(),
    buildSensitiveRiskPrompt(),
    buildBucketSpecificHardeningPrompt(selectedBucketMeta),
    buildRichIdeaRequirementsPrompt(),
    "contentAssets 必须包含 moments、xhsCarousel、wechatLongImage 三个对象。",
    buildContentAssetsSchemaPrompt(),
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
  lines.push(buildTrendFreshnessPrompt());
  lines.push(buildEvidenceBoundaryPrompt());
  lines.push(buildSensitiveRiskPrompt());
  lines.push(buildRichIdeaRequirementsPrompt());
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

function buildContentAssetsSchemaPrompt() {
  return [
    "contentAssets 必须包含 moments、xhsCarousel、wechatLongImage 三个对象。",
    "moments 只输出：title, caption, visualDirection。",
    "xhsCarousel 只输出：title, publishTitle, publishCaption, caption, slides；slides 固定 4 页；每页只输出 pageLabel, title, copy, visualDirection。",
    "wechatLongImage 只输出：title, publishTitle, intro, outline, positioning, cta, visualDirection；outline 为 3 到 5 条。",
    "不要输出 style、composition、prompt，系统会根据以上展示字段自动生成生图 prompt。",
    "字段长度要服务可展示内容：标题不超过 32 字，caption/publishCaption 按完整选题卡要求输出，slide.copy 40-80 字，intro 80-140 字，visualDirection 不超过 100 字。",
    "contentAssets 是内容选题页可展示的完整内容资产包，不只是生图 prompt。",
    "不要输出固定行业样例，不要把不属于当前品牌、趋势或选题的具体品牌、品类、生活场景带入；只有品牌档案、趋势或选题自然需要时才出现。",
  ].join("\n");
}

function normalizeTrendSet(rawTrends, brand, baseId) {
  const source = Array.isArray(rawTrends) ? rawTrends : rawTrends && typeof rawTrends === "object" ? Object.values(rawTrends) : [];
  return source
    .map(normalizeRawTrend)
    .filter((trend) => trend.title || trend.summary || trend.reason)
    .slice(0, TREND_ITEMS_PER_BUCKET)
    .map((trend, index) => {
      const ideas = Array.isArray(trend?.ideas) && trend.ideas.length
        ? trend.ideas.slice(0, 2).map((idea) => normalizeTrendIdea(idea, brand))
        : [];
      return {
        id: baseId + index + 1,
        stableKey: String(trend?.stableKey || trend?.stable_key || trend?.id || `${baseId + index + 1}`),
        rank: index + 1,
        title: String(trend?.title || `趋势方向 ${index + 1}`),
        category: String(trend?.category || "内容趋势"),
        summary: String(trend?.summary || "暂无趋势摘要"),
        score: clampScore(trend?.score),
        tags: normalizeTags(trend?.tags, [`#${brand.name}`]),
        reason: String(trend?.reason || "暂无适配原因"),
        ideas,
        customPrompt: "",
        systemPrompt: "",
      };
    })
    .filter((trend) => trend.ideas.length === 2);
}

function normalizeTrendIdea(idea, brand) {
  const rawIdea = normalizeRawIdea(idea);
  const normalized = sanitizeIdea(rawIdea, brand.audience, `#${brand.name}`);
  normalized.contentAssets = normalizeIdeaContentAssets(rawIdea);
  return normalized;
}

function normalizeRawTrend(trend) {
  if (typeof trend === "string") {
    return { title: trend };
  }
  if (!trend || typeof trend !== "object") return {};
  return {
    ...trend,
    title: trend.title || trend.name || trend.topic || trend.keyword || "",
    category: trend.category || trend.type || trend.bucket || trend.dimension || trend.scene || trend.tag || "",
    summary: trend.summary || trend.description || trend.desc || trend.insight || trend.content || trend.overview || trend.explanation || "",
    score: trend.score ?? trend.heat ?? trend.heatScore ?? trend.index ?? trend.popularity ?? trend.hotScore ?? trend.hotIndex,
    tags: trend.tags || trend.tagList || trend.hashtags || [],
    reason: trend.reason || trend.fitReason || trend.brandReason || trend.why || trend.rationale || trend.brandFitReason || trend.suitability || "",
    ideas:
      trend.ideas ||
      trend.ideaSkeletons ||
      trend.idea_skeletons ||
      trend.contentIdeas ||
      trend.content_ideas ||
      trend.topics ||
      trend.topicIdeas ||
      trend.topic_ideas ||
      trend.suggestions ||
      trend.ideaList ||
      trend.idea_list ||
      trend.angles ||
      [],
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
    contentAssets:
      idea.contentAssets ||
      idea.content_assets ||
      idea.assetPack ||
      idea.asset_pack ||
      idea.contentPack ||
      idea.content_pack ||
      {},
  };
}

function normalizeTrendBucketKey(value, bucketMeta = TREND_BUCKET_META) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text.toLowerCase().replace(/[\s_\-\/|:：、，,]+/g, "");
  const aliasMap = new Map([
    ["global", "xhs"],
    ["xiaohongshu", "xhs"],
    ["xhs", "xhs"],
    ["redbook", "xhs"],
    ["littleredbook", "xhs"],
    ["小红书", "xhs"],
    ["小红书热点", "xhs"],
    ["小红书热点话题", "xhs"],
    ["站内热点", "xhs"],
    ["news", "news"],
    ["新闻", "news"],
    ["新闻热点", "news"],
    ["新闻热点趋势", "news"],
    ["消费趋势", "news"],
    ["新闻热点消费趋势趋势", "news"],
    ["social", "social"],
    ["society", "social"],
    ["社会", "social"],
    ["社会热点", "social"],
    ["社会热点趋势", "social"],
    ["大众情绪", "social"],
    ["社会热点大众情绪趋势", "social"],
    ["traffic", "traffic"],
    ["flow", "traffic"],
    ["流量", "traffic"],
    ["流量热点", "traffic"],
    ["流量热点趋势", "traffic"],
    ["爆款套路", "traffic"],
    ["track", "track"],
    ["industry", "track"],
    ["category", "track"],
    ["赛道", "track"],
    ["赛道热点", "track"],
    ["赛道热点趋势", "track"],
    ["品类热点", "track"],
    ["品类热点指数", "track"],
    ["crowd", "crowd"],
    ["audience", "crowd"],
    ["user", "crowd"],
    ["people", "crowd"],
    ["人群", "crowd"],
    ["人群热点", "crowd"],
    ["人群热点趋势", "crowd"],
  ]);
  if (aliasMap.has(compact)) return aliasMap.get(compact);
  const matched = bucketMeta.find((bucket) => compact === bucket.key || compact === bucket.title.toLowerCase().replace(/[\s_\-\/|:：、，,]+/g, ""));
  return matched?.key || text;
}

function resolveRequestedTrendBucket(value, bucketMeta = TREND_BUCKET_META) {
  const key = normalizeTrendBucketKey(value || bucketMeta[0]?.key, bucketMeta);
  return bucketMeta.find((bucket) => bucket.key === key) || bucketMeta[0];
}

function getBucketItems(bucket) {
  return bucket?.items || bucket?.trends || bucket?.hotspots || bucket?.list || bucket?.data || bucket?.children || bucket?.results;
}

function normalizeTrendBuckets(rawBuckets, rawTrends, brand, baseId, bucketMeta = TREND_BUCKET_META) {
  const sourceBuckets = coerceTrendBuckets(rawBuckets, bucketMeta);
  if (!sourceBuckets.length && rawTrends) {
    sourceBuckets.push({ key: bucketMeta[0]?.key || "bucket-1", items: rawTrends });
  }
  const bucketsByKey = new Map();
  sourceBuckets.forEach((bucket, index) => {
    const fallbackKey = bucketMeta[index]?.key || `bucket-${index + 1}`;
    const rawKey = bucket?.key || bucket?.type || bucket?.name || bucket?.title || bucket?.dimension || bucket?.category || fallbackKey;
    const key = normalizeTrendBucketKey(rawKey, bucketMeta);
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
      items: normalizeTrendSet(getBucketItems(bucket), brand, baseId + bucketIndex * 100),
    };
  });
}

function coerceTrendBuckets(rawBuckets, bucketMeta = TREND_BUCKET_META) {
  if (Array.isArray(rawBuckets)) return rawBuckets;
  if (!rawBuckets || typeof rawBuckets !== "object") return [];
  const expectedKeys = bucketMeta.map((bucket) => bucket.key);
  const entries = Object.entries(rawBuckets);
  if (entries.some(([key]) => expectedKeys.includes(normalizeTrendBucketKey(key, bucketMeta)))) {
    return entries
      .filter(([key]) => expectedKeys.includes(normalizeTrendBucketKey(key, bucketMeta)))
      .map(([key, value]) => {
        const normalizedKey = normalizeTrendBucketKey(key, bucketMeta);
        return value && typeof value === "object" && !Array.isArray(value) ? { key: normalizedKey, ...value } : { key: normalizedKey, items: value };
      });
  }
  return entries.map(([key, value]) =>
    value && typeof value === "object" && !Array.isArray(value) ? { key, ...value } : { key, items: value },
  );
}

function unwrapTrendModelResult(result) {
  if (Array.isArray(result)) return { rawBuckets: result, rawTrends: null };
  const source =
    result?.trendBuckets ||
    result?.buckets ||
    result?.trend_buckets ||
    result?.trendBucket ||
    result?.hotspotBuckets ||
    result?.data?.trendBuckets ||
    result?.data?.buckets ||
    result?.data?.trend_buckets ||
    result?.result?.trendBuckets ||
    result?.result?.buckets ||
    result?.result?.trend_buckets;
  const rawTrends = result?.trends || result?.items || result?.hotspots || result?.list || result?.data?.trends || result?.result?.trends || null;
  return { rawBuckets: source, rawTrends };
}

function hasUsableTrendBuckets(trendBuckets, bucketMeta = TREND_BUCKET_META) {
  const requiredKeys = new Set(bucketMeta.map((bucket) => bucket.key));
  const totalItems = (trendBuckets || []).reduce((sum, bucket) => sum + (Array.isArray(bucket.items) ? bucket.items.length : 0), 0);
  return (
    Array.isArray(trendBuckets) &&
    trendBuckets.length === bucketMeta.length &&
    totalItems >= MIN_TREND_ITEMS_PER_BUCKET &&
    trendBuckets.every(
      (bucket) =>
        requiredKeys.has(bucket.key) &&
        Array.isArray(bucket.items) &&
        bucket.items.every((trend) => Array.isArray(trend.ideas) && trend.ideas.length === 2),
    )
  );
}

function hasFullTrendBuckets(trendBuckets, bucketMeta = TREND_BUCKET_META) {
  return (
    hasUsableTrendBuckets(trendBuckets, bucketMeta) &&
    trendBuckets.every((bucket) => Array.isArray(bucket.items) && bucket.items.length === TREND_ITEMS_PER_BUCKET)
  );
}

function hasCompleteTrendBucketContentAssets(trendBuckets, bucketMeta = TREND_BUCKET_META) {
  return (
    hasFullTrendBuckets(trendBuckets, bucketMeta) &&
    trendBuckets.every((bucket) =>
      bucket.items.every((trend) => (trend.ideas || []).every((idea) => hasCompleteIdeaContentAssets(idea))),
    )
  );
}

function getTrendBucketCountWarnings(trendBuckets) {
  return (trendBuckets || [])
    .filter((bucket) => Array.isArray(bucket.items) && bucket.items.length < TREND_ITEMS_PER_BUCKET)
    .map((bucket) => ({
      bucketKey: bucket.key || "",
      bucketTitle: bucket.title || bucket.key || "热点维度",
      expected: TREND_ITEMS_PER_BUCKET,
      actual: bucket.items.length,
    }));
}

function attachAnalysisWarnings(trendBuckets, warnings = []) {
  Object.defineProperty(trendBuckets, "analysisWarnings", {
    value: warnings,
    enumerable: false,
    configurable: true,
  });
  return trendBuckets;
}

async function resolvePgyEvidenceForTrendAnalysis(appConfig, brand, bucketMeta, options = {}) {
  if (!bucketMeta.some((bucket) => bucket.key === "xhs")) return null;
  if (options.pgyEvidence) return options.pgyEvidence;

  const categoryPath = normalizePgyCategoryPath(options.xhsCategoryPath || "");
  try {
    return await fetchPgyXhsHotNotes(appConfig, {
      categoryPath,
      pageSize: PGY_XHS_TREND_COUNT,
      pageNum: 1,
    });
  } catch (error) {
    if (appConfig?.pgy?.allowSearchFallback) {
      console.warn("[trend-analysis] pgy evidence unavailable; falling back to search for xhs bucket", {
        brandId: brand.id,
        brandName: brand.name,
        categoryPath,
        code: error?.code || "UNKNOWN",
        message: error?.code ? getPgyPublicErrorMessage(error) : String(error?.message || "unknown error"),
      });
      return null;
    }
    throw error;
  }
}

async function generateAiTrendSet(appConfig, brand, baseId, options = {}) {
  const selectedBucket = resolveRequestedTrendBucket(options.bucketKey || options.trendBucketKey || options.bucket || "xhs");
  return generateTrendBucketGroup(appConfig, brand, baseId, [selectedBucket], {
    ...options,
    bucketKey: selectedBucket.key,
    xhsCategoryPath: selectedBucket.key === "xhs" ? options.xhsCategoryPath : "",
  });
}

async function generateTrendBucketGroup(appConfig, brand, baseId, bucketMeta, options = {}) {
  const selectedBucketMeta = normalizePromptBucketMeta(bucketMeta);
  const pgyEvidence = await resolvePgyEvidenceForTrendAnalysis(appConfig, brand, selectedBucketMeta, options);
  const searchEnabled = Boolean(appConfig.textProvider.searchEnabled);
  const useSearchForBucket = searchEnabled && !selectedBucketMeta.some((bucket) => bucket.key === "xhs");

  try {
    const analysisAttempts = [
      { label: useSearchForBucket ? "search-enhanced" : "no-search", useSearch: useSearchForBucket, pgyEvidence, temperature: 0.3 },
      { label: useSearchForBucket ? "strict-search-enhanced" : "strict-no-search", useSearch: useSearchForBucket, pgyEvidence, temperature: 0.25, strict: true },
    ];
    let analysisCandidate = null;
    let lastAnalysisError = null;

    for (const attempt of analysisAttempts) {
      try {
        const userPrompt = buildTrendAnalysisUserPrompt(brand, {
          strict: attempt.strict,
          pgyEvidence: attempt.pgyEvidence,
          xhsCategoryPath: options.xhsCategoryPath,
        }, selectedBucketMeta);
        console.log("[trend-analysis] calling single-bucket text model", {
          brandId: brand.id,
          brandName: brand.name,
          bucketKeys: selectedBucketMeta.map((bucket) => bucket.key),
          attempt: attempt.label,
          useSearch: attempt.useSearch,
          userPromptLength: userPrompt.length,
          descriptionLength: String(brand.description || "").length,
          productLength: String(brand.product || "").length,
          knowledgeBaseLength: String(brand.knowledgeBase || "").length,
        });
        const result = await callTextModelJson(appConfig, {
          systemPrompt: buildTrendAnalysisSystemPrompt(selectedBucketMeta),
          userPrompt,
          useSearch: attempt.useSearch,
          temperature: attempt.temperature,
          timeoutMs: Number(options.textTimeoutMs || 180000),
          retries: 1,
          maxOutputTokens: Number(options.trendMaxOutputTokens || appConfig.textProvider.maxOutputTokens || 65536),
        });
        const { rawBuckets, rawTrends } = unwrapTrendModelResult(result);
        const trendBuckets = normalizeTrendBuckets(rawBuckets, rawTrends, brand, baseId, selectedBucketMeta);
        if (!hasUsableTrendBuckets(trendBuckets, selectedBucketMeta)) {
          console.warn("[trend-analysis] model returned incomplete trends", {
            brandId: brand.id,
            brandName: brand.name,
            bucketKeys: selectedBucketMeta.map((bucket) => bucket.key),
            attempt: attempt.label,
            resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
            bucketSizes: trendBuckets.map((bucket) => ({ key: bucket.key, count: bucket.items.length })),
          });
          throw new Error("文本模型返回了 JSON，但没有可用趋势或选题骨架不完整。");
        }
        if (!hasCompleteTrendBucketContentAssets(trendBuckets, selectedBucketMeta)) {
          const totalIdeas = trendBuckets.reduce(
            (sum, bucket) => sum + bucket.items.reduce((ideaSum, trend) => ideaSum + (trend.ideas || []).length, 0),
            0,
          );
          const completeIdeas = trendBuckets.reduce(
            (sum, bucket) =>
              sum +
              bucket.items.reduce(
                (ideaSum, trend) => ideaSum + (trend.ideas || []).filter((idea) => hasCompleteIdeaContentAssets(idea)).length,
                0,
              ),
            0,
          );
          console.warn("[trend-analysis] model returned incomplete content assets", {
            brandId: brand.id,
            brandName: brand.name,
            bucketKeys: selectedBucketMeta.map((bucket) => bucket.key),
            attempt: attempt.label,
            totalIdeas,
            completeIdeas,
          });
          throw new Error(`模型未按结构返回完整 contentAssets：${completeIdeas}/${totalIdeas} 个选题可用。`);
        }
        analysisCandidate = { trendBuckets };
        break;
      } catch (error) {
        lastAnalysisError = error;
        console.warn("[trend-analysis] single-bucket attempt failed", {
          brandId: brand.id,
          brandName: brand.name,
          attempt: attempt.label,
          useSearch: attempt.useSearch,
          message: error?.message || "unknown error",
        });
      }
    }

    if (!analysisCandidate) {
      throw lastAnalysisError || new Error("文本模型返回了 JSON，但没有可用趋势或选题骨架不完整。");
    }
    const { trendBuckets } = analysisCandidate;
    return attachAnalysisWarnings(trendBuckets, getTrendBucketCountWarnings(trendBuckets));
  } catch (error) {
    console.warn("[trend-analysis] failed without template fallback", {
      brandId: brand.id,
      brandName: brand.name,
      bucketKeys: selectedBucketMeta.map((bucket) => bucket.key),
      reason: error?.message || "empty model result",
    });
    if (String(error?.message || "").includes("contentAssets")) {
      throw error;
    }
    throw new Error("本次分析未能获取到可用热点，请稍后重试。");
  }
}

async function regenerateTrendIdeas(appConfig, brand, trend, customPrompt) {
  const systemPrompt = getSystemIdeaPrompt(brand, trend);
  const selectedBucket = resolveRequestedTrendBucket(trend.bucketKey || trend.bucketTitle || trend.category || "xhs");
  let result;
  try {
    result = await callTextModelJson(appConfig, {
      systemPrompt: `${buildIdeaRegenerationSystemPrompt([selectedBucket])}\n\n以下是默认品牌上下文：\n${systemPrompt}`,
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

  const normalizedIdeas = ideas.slice(0, 2).map((idea) => normalizeTrendIdea(idea, brand));
  if (normalizedIdeas.length !== 2 || !normalizedIdeas.every(hasCompleteIdeaContentAssets)) {
    throw new Error("文本模型未返回完整的选题内容资产。");
  }

  return {
    systemPrompt,
    ideas: normalizedIdeas,
  };
}

async function ensureTrendIdeaContentAssets(_appConfig, _brand, trend, ideaIndex) {
  const idea = trend?.ideas?.[Number(ideaIndex)];
  if (!idea) {
    throw new Error("当前选题不存在，请重新生成或刷新页面后再试。");
  }
  if (!hasCompleteIdeaContentAssets(idea)) {
    throw new Error("当前选题缺少趋势分析时生成的完整内容资产，请先重新生成趋势分析或重新生成选题。");
  }
  return { idea, filled: false };
}

module.exports = {
  PGY_XHS_TREND_COUNT,
  TREND_BUCKET_META,
  buildTrendAnalysisSystemPrompt,
  buildTrendAnalysisUserPrompt,
  buildPgyEvidencePromptBlock,
  buildXhsCategoryPromptBlock,
  buildIdeaRegenerationSystemPrompt,
  buildIdeaRegenerationUserPrompt,
  getSystemIdeaPrompt,
  normalizeTrendBucketKey,
  resolveRequestedTrendBucket,
  normalizeTrendSet,
  normalizeTrendBuckets,
  generateAiTrendSet,
  regenerateTrendIdeas,
  ensureTrendIdeaContentAssets,
};
