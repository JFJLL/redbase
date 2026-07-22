/**
 * Brand intelligence layer — derives structured brand understanding from the
 * brand archive before trend analysis runs.
 *
 * Flow: Brand Info → Brand Intelligence → Trend Analysis
 *
 * Deterministic (no model call, no DB write). Same brand fields always yield
 * the same intelligence object so prompts and tests stay stable.
 */

const EMPTY_INTELLIGENCE = Object.freeze({
  brand_position: "",
  consumer_problem: "",
  purchase_trigger: "",
  competitive_advantage: "",
  content_boundary: "",
  tone_style: "",
});

// Keep aligned with trend-service isMedicineBrand risk cues.
const MEDICINE_RISK_PATTERN = /(?:药品|用药|感冒药|儿童药|处方药|非处方药|医药|制药|OTC|医疗器械|退热贴)/i;
const MEDICINE_CONTENT_BOUNDARY = "严禁诊疗、剂量、功效、成分、适用人群与购买推荐；只做内容发起、整理与共创";

// Order matters: high-risk and more-specific profiles first.
const INDUSTRY_PROFILES = [
  {
    id: "medicine",
    match: MEDICINE_RISK_PATTERN,
    scenes: ["家长沟通场景", "信息核验场景", "家庭内容共创场景"],
    brand_position: (ctx) => `面向${ctx.audience}的内容沟通型品牌，以信息核验与家长/用户沟通角色参与内容`,
    consumer_problem: (ctx) => `${ctx.audience}在信息过载时需要可讨论、可核验的内容入口，而不是直接的诊疗或用药答案`,
    purchase_trigger: () => "家长沟通场景、信息核验场景、家庭内容共创场景（非产品功效触发）",
    // Never pull product/knowledge snippets — they often contain efficacy language.
    competitive_advantage: () => "作为内容发起者/整理者/共创方提供可参与的沟通机制，不新增功效卖点",
    content_boundary: () => MEDICINE_CONTENT_BOUNDARY,
    tone_style: () => "克制、中性、可讨论，像信息整理者而非医生",
    skipKnowledgeAppend: true,
    skipProductHooks: true,
  },
  {
    id: "coffee",
    match: /咖啡|cafe|coffee|拿铁|手冲|精品咖啡|咖啡豆|美式|意式/i,
    scenes: ["办公室场景", "通勤提神场景", "居家下午茶场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "咖啡"}品牌，优先占据办公室与通勤饮用场景`,
    consumer_problem: (ctx) => `${ctx.audience}在高强度节奏下需要稳定的办公室/通勤提神与情绪缓冲，却缺少贴合节奏的内容切入`,
    purchase_trigger: (ctx) => `办公室场景续杯、通勤提神、居家放松与社交分享等可立刻落地的饮用时机；产品钩子：${ctx.product || "咖啡产品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "办公室/通勤饮用场景理解与品牌档案中的产品事实"),
    content_boundary: () => "聚焦真实饮用体验、办公室/通勤场景与生活方式，不编造功效、不跟风无差异的“提神第一”红海口号",
    tone_style: () => "轻快、专业、有生活质感，像懂上班节奏的朋友推荐，避免硬广口号",
  },
  {
    id: "pet",
    match: /宠物|猫粮|狗粮|萌宠|养宠|猫砂|猫主|狗主/i,
    scenes: ["养宠日常场景", "护理互动场景", "宠物出行场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "宠物"}品牌，优先占据养宠日常与护理互动场景`,
    consumer_problem: (ctx) => `${ctx.audience}在养宠过程中需要靠谱的日常护理与情感共鸣内容，减少踩雷`,
    purchase_trigger: (ctx) => `日常喂养、护理节点、出行与季节变化；产品钩子：${ctx.product || "宠物产品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "养宠日常场景理解与品牌档案中的产品事实"),
    content_boundary: () => "聚焦养宠日常与情感表达，不输出诊疗建议或未提供的功效承诺",
    tone_style: () => "有爱、真实、有趣，像同为铲屎官的分享",
  },
  {
    id: "maternal",
    match: /母婴|育儿|宝宝|婴幼儿|孕妇|亲子|儿童护理|奶粉|辅食|纸尿裤|遛娃|带娃/i,
    scenes: ["育儿场景", "亲子日常场景", "家庭照护场景"],
    brand_position: (ctx) => `服务${ctx.audience}的${ctx.product || "母婴"}品牌，优先占据育儿与亲子日常场景`,
    consumer_problem: (ctx) => `${ctx.audience}在育儿场景中面对信息过载与选择焦虑，需要可执行、可验证的照护与内容参考`,
    purchase_trigger: (ctx) => `育儿场景中的成长节点、日常照护卡点与亲子互动时机；产品钩子：${ctx.product || "母婴产品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "育儿场景理解与品牌档案中的产品/服务事实"),
    content_boundary: () => "聚焦育儿场景、亲子日常与家庭沟通，不输出医疗诊断、剂量建议或绝对安全承诺",
    tone_style: () => "温柔、务实、有共情，像有经验的家长分享，避免恐吓式营销和专家口吻",
  },
  {
    id: "beauty",
    match: /美妆|护肤|彩妆|化妆品|面膜|精华|防晒|口红|底妆|洁面/i,
    scenes: ["早晚护肤场景", "妆前准备场景", "出行补妆场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "美妆护肤"}品牌，优先占据早晚护肤与妆前准备场景`,
    consumer_problem: (ctx) => `${ctx.audience}在护肤/妆容选择上既怕踩雷又怕无效，需要真实步骤与场景化用法`,
    purchase_trigger: (ctx) => `早晚护肤、换季维稳、妆前准备与出行补妆等场景；产品钩子：${ctx.product || "护肤/彩妆产品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "护肤/妆容场景理解与品牌档案中的产品事实"),
    content_boundary: () => "聚焦使用体验、步骤与肤感，不编造医学功效、成分奇迹或未提供的认证",
    tone_style: () => "细腻、真诚、可跟做，像懂行的闺蜜种草，避免夸张前后对比",
  },
  {
    id: "food",
    match: /食品|零食|饮料|茶饮|乳品|酸奶|坚果|速食|餐饮|烘焙|酒/i,
    scenes: ["居家分享场景", "办公室加餐场景", "聚会待客场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "食品"}品牌，优先占据居家分享与聚会待客场景`,
    consumer_problem: (ctx) => `${ctx.audience}需要解馋、便捷或可分享的饮食选择，并希望降低口味踩雷成本`,
    purchase_trigger: (ctx) => `居家分享、办公室加餐、聚会待客与情绪疗愈时刻；产品钩子：${ctx.product || "食品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "饮食分享场景理解与品牌档案中的产品事实"),
    content_boundary: () => "聚焦口味、场景与分享体验，不编造营养功效、医生推荐或适用人群承诺",
    tone_style: () => "松弛、有食欲、有烟火气，避免健康恐吓和功效夸大",
  },
  {
    id: "home",
    match: /家居|家电|收纳|家具|装修|生活用品|厨具|清洁|桌面|折叠/i,
    scenes: ["居家整理场景", "小空间改造场景", "日常使用场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "家居"}品牌，优先占据居家整理与小空间改造场景`,
    consumer_problem: (ctx) => `${ctx.audience}在有限空间与忙碌生活中需要更顺手的收纳、整理或家居解决方案`,
    purchase_trigger: (ctx) => `居家整理、搬家焕新、小空间改造与高频使用卡点；产品钩子：${ctx.product || "家居产品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "居家/小空间场景理解与品牌档案中的产品事实"),
    content_boundary: () => "聚焦使用方式、空间场景与效率提升，不编造未提供的材质认证或夸大效果",
    tone_style: () => "清晰、实用、有画面感，像真实住户分享改造经验",
  },
  {
    id: "fashion",
    match: /服装|服饰|穿搭|鞋靴|箱包|配饰|时尚|内衣|运动装/i,
    scenes: ["通勤穿搭场景", "约会场合场景", "季节换装场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "服饰"}品牌，优先占据通勤与场合穿搭场景`,
    consumer_problem: (ctx) => `${ctx.audience}在多场合切换中需要既好看又好穿的穿搭方案，避免无效囤货`,
    purchase_trigger: (ctx) => `通勤、约会、季节换装与重要场合的穿搭决策；产品钩子：${ctx.product || "服饰"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "穿搭场景理解与品牌档案中的产品事实"),
    content_boundary: () => "聚焦穿搭场景、版型与风格表达，不编造身材焦虑或未提供的功能承诺",
    tone_style: () => "有审美、接地气、可模仿，避免高高在上的时尚说教",
  },
  {
    id: "education",
    match: /教育|学习|培训|课程|知识付费|备考|职业技能|少儿教育/i,
    scenes: ["学习计划场景", "备考冲刺场景", "技能提升场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "学习"}品牌，优先占据学习计划与备考冲刺场景`,
    consumer_problem: (ctx) => `${ctx.audience}面对学习目标时缺路径、缺反馈，容易半途而废或信息过载`,
    purchase_trigger: (ctx) => `开学节点、备考窗口、转岗提升与技能卡点；产品钩子：${ctx.product || "课程/学习服务"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "学习场景理解与品牌档案中的产品/服务事实"),
    content_boundary: () => "聚焦方法、路径与学习场景，不承诺成绩/上岸结果或编造未提供的名师背书",
    tone_style: () => "清晰、鼓励、可执行，像靠谱学长学姐拆解方法",
  },
  {
    id: "health_device",
    match: /血压计|血糖仪|理疗|健康监测|穿戴|保健|大健康/i,
    scenes: ["居家记录场景", "日常监测场景", "家庭照护场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "健康记录"}品牌，优先占据居家记录与家庭沟通场景`,
    consumer_problem: (ctx) => `${ctx.audience}需要把零散健康信息整理成可沟通、可追踪的日常记录，而不是被动接受恐吓式信息`,
    purchase_trigger: (ctx) => `居家记录、家庭沟通与日常监测节奏；产品钩子：${ctx.product || "健康相关产品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "居家记录场景理解与品牌档案中的产品事实"),
    content_boundary: () => "只做信息整理、记录与沟通内容，不输出诊疗建议、疗效承诺、剂量或适用人群结论",
    tone_style: () => "克制、清晰、有边界，像冷静的家庭信息整理者",
  },
  {
    id: "tech",
    match: /数码|电子|手机|电脑|智能|软件|SaaS|互联网|科技|APP|应用/i,
    scenes: ["效率工具场景", "远程办公场景", "学习工作切换场景"],
    brand_position: (ctx) => `面向${ctx.audience}的${ctx.product || "科技"}品牌，优先占据效率工具与远程办公场景`,
    consumer_problem: (ctx) => `${ctx.audience}在工具过载中需要真正省时间、可上手的解决方案`,
    purchase_trigger: (ctx) => `远程办公、学习工作切换、效率卡点与设备升级节点；产品钩子：${ctx.product || "科技产品"}`,
    competitive_advantage: (ctx) => archiveAdvantage(ctx, "效率场景理解与品牌档案中的产品事实"),
    content_boundary: () => "聚焦使用场景与效率体验，不编造未提供的性能数据或绝对第一表述",
    tone_style: () => "利落、有干货、可跟做，避免空洞科技黑话",
  },
];

function archiveAdvantage(ctx, sceneFallback) {
  return ctx.productSnippet || ctx.goalSnippet || ctx.knowledgeSnippet || sceneFallback;
}

function compactText(value, maxLength = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function collectBrandCorpus(brand) {
  return [
    brand?.name,
    brand?.industry,
    brand?.audience,
    brand?.description,
    brand?.product,
    brand?.goal,
    brand?.knowledgeBase || brand?.knowledge_base,
    ...(Array.isArray(brand?.assetTags) ? brand.assetTags : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function isMedicineRiskBrand(brand, corpus = "") {
  const text = corpus || collectBrandCorpus(brand);
  return MEDICINE_RISK_PATTERN.test(text);
}

function buildBrandContext(brand) {
  const audience = compactText(brand?.audience, 36) || "目标用户";
  const product = compactText(brand?.product, 40);
  const industry = compactText(brand?.industry, 40) || "所属品类";
  const productSnippet = compactText(brand?.product || brand?.description, 48);
  const goalSnippet = compactText(brand?.goal, 48);
  const knowledgeSnippet = compactText(brand?.knowledgeBase || brand?.knowledge_base, 60);
  return {
    audience,
    product,
    industry,
    productSnippet,
    goalSnippet,
    knowledgeSnippet,
    name: compactText(brand?.name, 40) || "品牌",
  };
}

function matchIndustryProfile(corpus) {
  for (const profile of INDUSTRY_PROFILES) {
    if (profile.match.test(corpus)) return profile;
  }
  return null;
}

function buildGenericIntelligence(ctx) {
  return {
    brand_position: `面向${ctx.audience}的${ctx.product || ctx.industry}品牌，围绕真实使用场景建立可识别定位`,
    consumer_problem: `${ctx.audience}在选择${ctx.product || ctx.industry}时需要更清晰的决策理由与可落地的使用场景`,
    purchase_trigger: `与${ctx.audience}日常节奏相关的具体使用场景与决策节点；产品钩子：${ctx.product || ctx.industry}`,
    competitive_advantage: archiveAdvantage(ctx, "品牌档案中可核验的产品事实与目标受众场景理解"),
    content_boundary: "只使用品牌档案明确提供的事实，不编造卖点、认证、功效或适用人群；内容切入需避开同质化空话红海",
    tone_style: "真诚、具体、有场景感，像懂用户生活的运营顾问",
  };
}

function buildMedicineSafeIntelligence(ctx) {
  return {
    brand_position: `面向${ctx.audience}的内容沟通型品牌，以信息核验与家长/用户沟通角色参与内容`,
    consumer_problem: `${ctx.audience}在信息过载时需要可讨论、可核验的内容入口，而不是直接的诊疗或用药答案`,
    purchase_trigger: "家长沟通场景、信息核验场景、家庭内容共创场景（非产品功效触发）",
    competitive_advantage: "作为内容发起者/整理者/共创方提供可参与的沟通机制，不新增功效卖点",
    content_boundary: MEDICINE_CONTENT_BOUNDARY,
    tone_style: "克制、中性、可讨论，像信息整理者而非医生",
  };
}

function resolveField(valueOrFn, ctx) {
  return typeof valueOrFn === "function" ? String(valueOrFn(ctx) || "").trim() : String(valueOrFn || "").trim();
}

/**
 * Build structured brand intelligence from brands-table fields.
 * @param {object} brand - brand archive (industry, audience, description, product, goal, knowledgeBase)
 * @returns {{
 *   brand_position: string,
 *   consumer_problem: string,
 *   purchase_trigger: string,
 *   competitive_advantage: string,
 *   content_boundary: string,
 *   tone_style: string,
 * }}
 */
function buildBrandIntelligence(brand) {
  if (!brand || typeof brand !== "object") {
    return { ...EMPTY_INTELLIGENCE };
  }

  const ctx = buildBrandContext(brand);
  const corpus = collectBrandCorpus(brand);
  // Hard override for any medicine/high-risk medicine cue, even if another
  // industry keyword appears first in free-form text.
  if (isMedicineRiskBrand(brand, corpus)) {
    return buildMedicineSafeIntelligence(ctx);
  }

  const profile = matchIndustryProfile(corpus);
  const base = profile
    ? {
        brand_position: resolveField(profile.brand_position, ctx),
        consumer_problem: resolveField(profile.consumer_problem, ctx),
        purchase_trigger: resolveField(profile.purchase_trigger, ctx),
        competitive_advantage: resolveField(profile.competitive_advantage, ctx),
        content_boundary: resolveField(profile.content_boundary, ctx),
        tone_style: resolveField(profile.tone_style, ctx),
      }
    : buildGenericIntelligence(ctx);

  // Fold primary scenes into purchase_trigger when the profile defines them,
  // so acceptance cases like 咖啡→办公室场景 / 母婴→育儿场景 stay explicit.
  if (profile?.scenes?.length) {
    const sceneHint = profile.scenes.join("、");
    if (!base.purchase_trigger.includes(profile.scenes[0])) {
      base.purchase_trigger = `${sceneHint}；${base.purchase_trigger}`;
    }
  }

  // Prefer knowledge_base nuances when present without inventing product claims.
  // Never append knowledge for profiles that skip it (medicine already returned above).
  if (
    !profile?.skipKnowledgeAppend
    && ctx.knowledgeSnippet
    && !base.competitive_advantage.includes(ctx.knowledgeSnippet.slice(0, Math.min(12, ctx.knowledgeSnippet.length)))
  ) {
    base.competitive_advantage = `${base.competitive_advantage}；资料要点：${ctx.knowledgeSnippet}`;
  }

  return {
    brand_position: base.brand_position,
    consumer_problem: base.consumer_problem,
    purchase_trigger: base.purchase_trigger,
    competitive_advantage: base.competitive_advantage,
    content_boundary: base.content_boundary,
    tone_style: base.tone_style,
  };
}

/**
 * Safe intelligence for medicine+child traffic prompts: keep parental scenes
 * and content-role framing, strip product-advantage leakage.
 */
function buildSafeBrandIntelligenceForMedicineTraffic(brand) {
  const audience = compactText(brand?.audience, 36) || "儿童家长";
  return {
    brand_position: `面向${audience}的内容发起者/整理者/共创方，以育儿场景与家长沟通为主要表达语境`,
    consumer_problem: `${audience}需要可讨论、可核验的育儿与家庭内容入口，而不是诊疗或产品答案`,
    purchase_trigger: "育儿场景、家长沟通场景、信息核验与内容共创时机（非产品功效触发）",
    competitive_advantage: "作为内容发起者、整理者或共创方参与讨论的能力",
    content_boundary: MEDICINE_CONTENT_BOUNDARY,
    tone_style: "克制、中性、可讨论",
  };
}

function formatBrandIntelligencePromptLines(intelligence, options = {}) {
  if (!intelligence || typeof intelligence !== "object") return [];
  const fields = [
    ["品牌定位", intelligence.brand_position],
    ["消费者问题", intelligence.consumer_problem],
    ["购买触发", intelligence.purchase_trigger],
    ["竞争优势", intelligence.competitive_advantage],
    ["内容边界", intelligence.content_boundary],
    ["语气风格", intelligence.tone_style],
  ].filter(([, value]) => String(value || "").trim());

  if (!fields.length) return [];

  const lines = [
    "品牌智能层（趋势生成前已完成；用于理解品牌是谁、在什么场景说话，不是热点证据）：",
    ...fields.map(([label, value]) => `${label}：${String(value).trim()}`),
    "品牌智能层中的场景与定位是策略理解，不是可新增的产品事实；idea.brandFit 仍只能使用品牌档案明确提供的事实，不得把智能层措辞改写成未提供的功效、认证或卖点。",
  ];

  if (options.includeJudgmentCriteria !== false) {
    lines.push(
      "趋势适配判断标准（禁止停留在“是否适合品牌”的模糊判断）：",
      "1) 是否强化品牌优势：reason/brandFit 须对照竞争优势中来自品牌档案的事实说明如何借势放大差异点。",
      "2) 是否创造新消费场景：须落到本品牌智能层购买触发/消费者问题中的具体场景，不能只写泛人群。",
      "3) 是否避开竞品红海：须在内容边界内选择差异化切入，避免同质口号与无证据的功效/销量战。",
    );
  }

  return lines;
}

module.exports = {
  buildBrandIntelligence,
  buildSafeBrandIntelligenceForMedicineTraffic,
  formatBrandIntelligencePromptLines,
  isMedicineRiskBrand,
  EMPTY_INTELLIGENCE,
};
