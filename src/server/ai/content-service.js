const { normalizeChineseCopy } = require("../utils");

const XHS_CAROUSEL_SLIDE_COUNT = 4;

const XHS_VISUAL_STYLE_PRESETS = Object.freeze({
  lifestyle: {
    label: "真实生活方式",
    description: "自然光、真实使用场景与轻松抓拍感",
    style: "真实生活方式摄影，松弛自然、可信、不过度修饰",
    layout: "以完整生活场景承载主体，标题区与人物或产品错位排布，局部细节作为次级证据，保留充足呼吸感",
    execution: "自然窗光或柔和环境光，暖中性色与品牌色点缀，35mm 纪实视角，保留真实材质、轻微生活痕迹和自然景深",
    avoid: "棚拍塑料感、过度磨皮、夸张商业灯光、悬浮产品、空洞样板间",
  },
  editorial: {
    label: "杂志编辑感",
    description: "克制高级，适合审美与品牌内容",
    style: "中文生活方式杂志编辑视觉，克制、精致、有明确观点",
    layout: "使用非对称编辑网格，大标题、主体图和短注释形成三级层级，边缘对齐准确，留白不少于画面的三分之一",
    execution: "低饱和品牌配色，柔和侧光与干净阴影，50mm 编辑摄影质感，纸张、织物或哑光材质细节清晰",
    avoid: "廉价渐变、满版装饰、促销爆炸贴、过度金色、密集小字和传统电商详情页",
  },
  native_note: {
    label: "原生笔记感",
    description: "便签、圈画和真实记录，弱化广告感",
    style: "小红书原生用户笔记感，真实照片、随手记录与轻量标注",
    layout: "主照片占据视觉中心，搭配一到两块便签、圈画或下划线提示；元素有轻微手工错位，但阅读顺序清楚",
    execution: "手机抓拍视角，自然光，轻微颗粒和纸张纹理，使用一到两个高亮色，保留真实环境与使用痕迹",
    avoid: "品牌发布会海报、过度整齐模板、卡通贴纸堆叠、随机英文、伪造手写长文",
  },
  knowledge: {
    label: "专业知识卡",
    description: "步骤清晰，适合教程、科普与方法论",
    style: "专业知识卡片与可信中文信息设计，清楚但不刻板",
    layout: "一页只讲一个结论，标题、编号、示意图和关键提示形成明确层级；图文比例约六比四，信息块边界清楚",
    execution: "高对比中性色搭配单一重点色，扁平示意与真实细节图结合，统一圆角和线性图标，网格对齐精确",
    avoid: "复杂仪表盘、无来源数据、密集表格、教科书式大段文字、低对比灰字",
  },
  checklist: {
    label: "清单攻略型",
    description: "编号、清单和收藏提示，适合攻略避坑",
    style: "可快速扫读和收藏的小红书清单攻略视觉",
    layout: "顶部给明确收益标题，中部只放三到五个短清单项并配编号或小图，底部用一句总结形成收束",
    execution: "明亮但克制的重点色，真实场景小图与简洁符号组合，编号尺寸明显，行距充足，手机缩略图仍能识别重点",
    avoid: "超过五个并列重点、长段解释、荧光色堆叠、复杂背景、诱导式夸张承诺",
  },
  review: {
    label: "产品测评型",
    description: "细节特写、对比和真实使用证据",
    style: "真实产品测评笔记，强调可验证的使用细节与客观证据",
    layout: "产品或人物使用场景为主视觉，辅以一到两个细节放大、前后对比或标注线，卖点必须落在具体证据上",
    execution: "中性自然光，产品颜色与结构准确，微距细节和正常使用视角结合，背景来自真实场景，质感清楚但不过度锐化",
    avoid: "凭空改变包装、虚构功能、夸大前后对比、悬浮零件、纯白棚拍详情页和虚假检测数据",
  },
  mood: {
    label: "情绪氛围型",
    description: "少文字、电影感，适合故事与情绪表达",
    style: "情绪化生活摄影与克制电影感，画面优先于说明文字",
    layout: "沉浸式大图占主体，只保留一句短标题；利用前景、人物视线或空间纵深引导阅读，留出安静的文字安全区",
    execution: "电影式自然光、柔和高光和有层次的暗部，低饱和综合色调，35mm 或 50mm 叙事镜头，保留空气感与真实肤色",
    avoid: "夸张滤镜、黑成一片的暗部、无意义忧郁姿势、影楼摆拍、密集信息卡",
  },
  collage: {
    label: "拼贴灵感型",
    description: "多图拼贴、纸张肌理和灵感板气质",
    style: "有秩序的小红书灵感拼贴，丰富但不杂乱",
    layout: "一张主图配两到四个局部切片，使用纸张边缘、色卡和细线组织层级；所有切片围绕同一个主题，不遮挡标题",
    execution: "统一色温和颗粒，真实纸张与胶带纹理，有限色板，主次比例明确，拼贴边缘自然且有轻微手工感",
    avoid: "素材无关、元素重叠失控、贴纸铺满、不同画质和色温混杂、剪贴边缘粗糙",
  },
  minimal_brand: {
    label: "极简品牌型",
    description: "单主体、统一品牌色与精致留白",
    style: "极简品牌视觉，单一强主体、精确构图与高级材质",
    layout: "主体位于居中轴或黄金分割点，大面积留白承载短标题，品牌识别通过颜色、材质或真实标识自然出现",
    execution: "单一主色加中性色，柔和定向光与干净阴影，50mm 或 85mm 商业摄影，材质纹理清晰，背景简洁但不空洞",
    avoid: "凭空生成 Logo、奢华符号堆砌、无关道具、强反光塑料感、传统硬广口号",
  },
});

const WECHAT_LONG_IMAGE_TEMPLATES = Object.freeze({
  editorial: {
    label: "深度观点",
    description: "适合行业洞察、品牌观点与趋势解读",
    style: "中文人文与商业杂志编辑风格，克制、专业、有观点感",
    structure: "头图观点区 → 核心结论 → 3 个论证模块 → 总结金句 → 轻量署名",
    execution: "使用稳定的编辑网格、低饱和中性色、单一重点色、真实编辑摄影和细线分隔；标题层级强，正文摘要留白充足",
    avoid: "空泛金句墙、过多装饰引号、新闻客户端模板、密集长段文字",
  },
  tutorial: {
    label: "干货教程",
    description: "适合步骤方法、操作指南和科普",
    style: "清晰教程信息设计，步骤明确、示意可信、容易照做",
    structure: "标题与收益 → 准备事项 → 3 至 5 个步骤 → 常见误区 → 行动清单",
    execution: "使用连续编号、统一步骤卡、简洁示意图和真实局部图；每个模块只保留动作、结果与一个关键提醒",
    avoid: "步骤跳跃、过多图标、长段说明、无法执行的抽象建议、装饰性流程图",
  },
  report: {
    label: "行业报告",
    description: "适合数据、趋势、结论和专业内容",
    style: "可信行业报告视觉，数据卡片、简洁图表与专业网格",
    structure: "报告标题 → 关键数字 → 趋势拆解 → 结论卡片 → 方法建议 → 来源提示",
    execution: "深色文字、浅色背景和克制强调色；图表只表现输入中明确存在的数据，数字卡、趋势图与结论一一对应",
    avoid: "虚构数字或来源、三维图表、复杂仪表盘、数据装饰化、过小坐标文字",
  },
  story: {
    label: "品牌故事",
    description: "适合人物、时间线和品牌幕后内容",
    style: "有温度的纪录片与杂志叙事感，真实、具体、有时间流动",
    structure: "故事钩子 → 起点 → 转折 → 关键选择 → 结果与感受 → 价值收束",
    execution: "真实人物或场景照片、时间线节点与细节特写交替出现；色调统一，转折处通过构图和留白建立节奏",
    avoid: "企业大事记墙、假合影、过度煽情、口号代替事实、每段使用相同版式",
  },
  product: {
    label: "产品说明",
    description: "从真实痛点与场景解释产品价值",
    style: "现代产品编辑视觉，用真实场景和细节证据解释价值",
    structure: "用户痛点 → 使用场景 → 3 个核心价值 → 细节证据 → 适用人群 → 轻 CTA",
    execution: "场景图、产品细节和功能示意按问题—证据配对；保持产品外形、颜色和包装准确，品牌色只用于导航和重点",
    avoid: "卖点罗列墙、悬浮产品、虚构结构剖面、夸大效果、促销价格标签",
  },
  minimal: {
    label: "极简长图",
    description: "少字强观点，适合封面式传播",
    style: "极简中文编辑设计，大留白、强标题与少量高质量图像",
    structure: "强标题 → 一句话结论 → 3 个短观点 → 总结金句 → 署名",
    execution: "每屏只保留一个视觉焦点，使用统一基线、大字号标题和单色块节奏；装饰数量严格受控",
    avoid: "为了填满画布增加内容、过多字体、渐变背景堆叠、无意义图标和小字说明",
  },
});

const XHS_PAGE_ROLES = Object.freeze([
  { name: "停留封面", goal: "用 8 至 16 字的强钩子制造停留，只突出一个视觉主体与一个核心矛盾", density: "最低文字密度，标题是唯一主要文字" },
  { name: "场景代入", goal: "用具体人物、时间、地点或使用情境让目标用户产生‘这就是我’的代入感", density: "以真实场景为主，最多补充两个短标签" },
  { name: "价值证明", goal: "用步骤、对比、细节或真实使用证据解释方法与产品价值，避免空泛口号", density: "允许三到四个短信息点，但每个信息点不超过一行" },
  { name: "收藏收束", goal: "用总结清单、结论或行动建议提供收藏理由，品牌露出轻量自然", density: "以可保存的结论或清单收束，不重复前页内容" },
]);

function getText(source, key, maxLength) {
  return normalizeChineseCopy(String(source?.[key] || "").trim()).slice(0, maxLength);
}

function getRequiredText(source, key, label, maxLength) {
  const text = getText(source, key, maxLength);
  if (!text) {
    throw new Error(`AI 内容生成结果缺少 ${label}。`);
  }
  return text;
}

function compactJoin(parts) {
  return parts.map((part) => normalizeChineseCopy(part)).filter(Boolean).join("；");
}

function stablePresetIndex(value, length) {
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return length ? hash % length : 0;
}

function resolvePresetKey(requestedKey, presets, seed, keywordRules = []) {
  const normalizedKey = String(requestedKey || "auto").trim();
  if (presets[normalizedKey]) return normalizedKey;
  const source = String(seed || "").toLowerCase();
  for (const [pattern, key] of keywordRules) {
    if (pattern.test(source) && presets[key]) return key;
  }
  const keys = Object.keys(presets);
  return keys[stablePresetIndex(source, keys.length)] || keys[0];
}

function resolveXhsVisualStyle(requestedKey, seed) {
  return resolvePresetKey(requestedKey, XHS_VISUAL_STYLE_PRESETS, seed, [
    [/(测评|对比|开箱|实测|好物|种草)/, "review"],
    [/(教程|方法|步骤|科普|知识|指南)/, "knowledge"],
    [/(清单|攻略|避坑|合集|必看)/, "checklist"],
    [/(故事|情绪|治愈|成长|经历|感受)/, "mood"],
    [/(穿搭|灵感|家居|审美|搭配)/, "collage"],
    [/(高端|品质|新品|设计|美学)/, "editorial"],
    [/(日常|生活|通勤|使用|体验)/, "lifestyle"],
  ]);
}

function resolveWechatTemplate(requestedKey, seed) {
  return resolvePresetKey(requestedKey, WECHAT_LONG_IMAGE_TEMPLATES, seed, [
    [/(教程|方法|步骤|科普|指南)/, "tutorial"],
    [/(报告|数据|趋势|行业|洞察)/, "report"],
    [/(故事|人物|幕后|历程|经历)/, "story"],
    [/(产品|功能|卖点|使用|场景)/, "product"],
    [/(观点|思考|为什么|深度)/, "editorial"],
  ]);
}

function compactBrandContext(brand) {
  if (!brand || typeof brand !== "object") return "";
  const isPersonal = brand.profileType === "personal";
  const tags = Array.isArray(brand.assetTags) ? brand.assetTags.filter(Boolean).slice(0, 6).join("、") : "";
  const pillars = Array.isArray(brand.contentPillars) ? brand.contentPillars.filter(Boolean).slice(0, 4).join("、") : "";
  return compactJoin([
    `${isPersonal ? "个人 IP" : "品牌"}：${brand.name || "当前创作主体"}`,
    brand.industry ? `${isPersonal ? "内容领域" : "行业"}：${brand.industry}` : "",
    brand.audience ? `目标人群：${brand.audience}` : "",
    brand.product ? `${isPersonal ? "专长或服务" : "产品或服务"}：${brand.product}` : "",
    brand.personaStyle ? `表达气质：${brand.personaStyle}` : "",
    pillars ? `长期内容栏目：${pillars}` : "",
    tags ? `${isPersonal ? "内容标签" : "品牌资产标签"}：${tags}` : "",
  ]);
}

function shouldPreserveSourceCreativeDirection(carouselPack, stylePreset) {
  if (String(stylePreset || "").trim() !== "source") return false;
  return Boolean(carouselPack?.remixBrief || carouselPack?.sourceTemplate);
}

function applyXhsCreativeDirection(carouselPack, { stylePreset, brand, idea, aspectRatio = "3:4" } = {}) {
  if (shouldPreserveSourceCreativeDirection(carouselPack, stylePreset)) {
    return {
      ...carouselPack,
      aspectRatio,
      creativeStyle: "source",
      creativeStyleLabel: "保留案例结构",
      creativeStyleDescription: "沿用优秀案例提炼出的视觉结构，不叠加固定风格模板",
      slides: (Array.isArray(carouselPack?.slides) ? carouselPack.slides : []).map((slide) => ({ ...slide, aspectRatio })),
    };
  }

  const source = `${idea?.title || ""} ${idea?.summary || ""} ${carouselPack?.publishTitle || ""} ${carouselPack?.caption || ""}`;
  const resolvedStyleKey = resolveXhsVisualStyle(stylePreset, source);
  const preset = XHS_VISUAL_STYLE_PRESETS[resolvedStyleKey];
  const isPersonal = brand?.profileType === "personal";
  const brandContext = compactBrandContext(brand);
  const accountRule = isPersonal
    ? "身份一致性优先：以人物真实外貌、经历、生活环境和表达气质作为识别核心；没有商品时不要强加产品，不要把头像当作 Logo、贴纸或独立商品。"
    : "产品真实性优先：让价值通过真实使用场景、材质细节和体验证据自然出现；不得改变产品核心造型、包装和颜色，未提供 Logo 参考图时不要虚构 Logo 或品牌文字。";
  const slides = (Array.isArray(carouselPack?.slides) ? carouselPack.slides : []).map((slide, index) => {
    const role = XHS_PAGE_ROLES[index] || XHS_PAGE_ROLES[XHS_PAGE_ROLES.length - 1];
    const basePrompt = String(slide?.prompt || "").replace(/3:4/g, aspectRatio);
    const creativeDirection = [
      "【小红书组图创意导演任务】",
      brandContext,
      `整组主题：${carouselPack?.publishTitle || carouselPack?.title || idea?.title || "当前选题"}`,
      `视觉路线：${preset.label}——${preset.style}`,
      `视觉执行：${preset.execution}`,
      `本页角色：${role.name}——${role.goal}`,
      `本页内容：标题“${slide?.title || ""}”；核心表达“${slide?.copy || slide?.contentGoal || ""}”`,
      `构图与层级：${preset.layout}；${role.density}；视觉焦点必须在缩略图尺寸下仍然明确。`,
      `主体与品牌：${accountRule}`,
      `文字与安全区：画面只允许出现本页标题“${slide?.title || ""}”以及必要的极短标签；中文标题建议 8 至 16 字，保留四周安全边距，禁止长段正文、随机英文、乱码、伪 Logo 和无意义小字。`,
      "组图连续性：四页使用同一色板、光线逻辑、字体区域、圆角/线条语言和材质体系；每页构图必须有变化，不能只是替换文字。",
      "真实与可信：人物肢体、产品比例、材质、包装和空间透视必须自然；只表现输入中存在的事实，不虚构数据、认证、功效或使用结果。",
      `严格避免：${preset.avoid}；同时避免电商详情页、传统促销海报、画面拥挤、重复主体、错误手指、畸变产品、低清晰度和水印。`,
      `输出规格：${aspectRatio} 竖版高质量成图，主体边缘干净，标题区可读，适合小红书手机端连续滑动阅读。`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      ...slide,
      aspectRatio,
      style: `${preset.style}；${preset.execution}`,
      composition: `${role.name}；${preset.layout}；${aspectRatio} 竖版；一页只表达一个重点。`,
      pageRole: role.name,
      creativeStyle: resolvedStyleKey,
      creativeStyleLabel: preset.label,
      creativeDirection: {
        type: "xhs",
        label: preset.label,
        description: preset.description,
        style: preset.style,
        layout: preset.layout,
        execution: preset.execution,
        avoid: preset.avoid,
        pageRole: role.name,
        pageGoal: role.goal,
        density: role.density,
        title: slide?.title || "",
        copy: slide?.copy || slide?.contentGoal || "",
        aspectRatio,
      },
      prompt: `${basePrompt}\n\n${creativeDirection}`.trim(),
    };
  });
  return {
    ...carouselPack,
    aspectRatio,
    creativeStyle: resolvedStyleKey,
    creativeStyleLabel: preset.label,
    creativeStyleDescription: preset.description,
    slides,
  };
}

function applyWechatCreativeDirection(wechatPack, { template, brand, idea, aspectRatio = "9:21" } = {}) {
  const source = `${idea?.title || ""} ${idea?.summary || ""} ${wechatPack?.publishTitle || ""} ${wechatPack?.positioning || ""}`;
  const resolvedTemplateKey = resolveWechatTemplate(template, source);
  const selectedTemplate = WECHAT_LONG_IMAGE_TEMPLATES[resolvedTemplateKey];
  const isPersonal = brand?.profileType === "personal";
  const basePrompt = String(wechatPack?.prompt || "").replace(/9:16|9:21/g, aspectRatio);
  const outline = Array.isArray(wechatPack?.outline) ? wechatPack.outline.filter(Boolean).slice(0, 5) : [];
  const brandRule = isPersonal
    ? "保持个人表达、真实经历和日常环境的一致性；头像或人物只作为身份参考，不企业化包装，不强行植入不存在的商品。"
    : "品牌只通过真实产品、场景、色彩和底部署名自然出现；保持产品造型、包装与颜色准确，不做夸张承诺，不把长图做成促销详情页。";
  const prompt = [
    basePrompt,
    "",
    "【公众号长图创意导演任务】",
    compactBrandContext(brand),
    `发布主题：${wechatPack?.publishTitle || idea?.title || "当前内容"}`,
    outline.length ? `内容大纲：${outline.map((item, index) => `${index + 1}. ${item}`).join(" / ")}` : "",
    `内容模板：${selectedTemplate.label}——${selectedTemplate.description}`,
    `视觉风格：${selectedTemplate.style}`,
    `阅读结构：${selectedTemplate.structure}`,
    `视觉执行：${selectedTemplate.execution}`,
    `主体与品牌：${brandRule}`,
    `版式规格：使用 ${aspectRatio} 竖版，将内容组织成 5 至 7 个边界明确的连续模块；顶部先给标题和核心收益，中段按大纲建立节奏，底部用结论或轻 CTA 收束。`,
    "移动端可读性：设置标题、模块标题、关键短句、说明四级层级；字号和行距有明显差异，左右留白稳定，装饰不得压住信息。",
    "文字控制：图片内只呈现标题、章节名、关键短句、输入中明确存在的数字和极短说明；禁止生成长段正文、随机英文、乱码、错误数据、伪造来源、水印和过密小字。",
    "视觉一致性：全图统一色板、图标、插图或摄影语言、圆角和分隔线；相邻模块交替使用图像、数字卡、短清单或留白，避免从上到下重复同一张卡片。",
    `严格避免：${selectedTemplate.avoid}；同时避免信息拥堵、低对比度、拉伸图片、错误人物肢体、产品变形、硬广口号和无依据的效果承诺。`,
    "输出要求：生成一张完整、高清、边缘干净的公众号长图，首屏有停留力，中段可连续阅读，末屏有明确收束。",
  ]
    .filter((line) => line !== null && line !== undefined && line !== "")
    .join("\n");
  return {
    ...wechatPack,
    platform: "wechat",
    aspectRatio,
    template: resolvedTemplateKey,
    templateLabel: selectedTemplate.label,
    templateDescription: selectedTemplate.description,
    style: `${selectedTemplate.style}；${selectedTemplate.execution}`,
    composition: `${aspectRatio} 竖版；${selectedTemplate.structure}；5 至 7 个模块边界清楚，适合手机连续阅读。`,
    creativeDirection: {
      type: "wechat",
      label: selectedTemplate.label,
      description: selectedTemplate.description,
      style: selectedTemplate.style,
      structure: selectedTemplate.structure,
      execution: selectedTemplate.execution,
      avoid: selectedTemplate.avoid,
      title: wechatPack?.publishTitle || idea?.title || "",
      outline,
      aspectRatio,
    },
    prompt,
  };
}

function buildMomentsPrompt({ title, caption, visualDirection, style, composition }) {
  return compactJoin([
    `生成朋友圈配图，主题是“${title}”`,
    caption ? `发布文案围绕：${caption}` : "",
    visualDirection ? `视觉方向：${visualDirection}` : "",
    style ? `风格：${style}` : "",
    composition ? `构图：${composition}` : "",
    "画面真实、干净、有品牌相关性，避免硬广海报感",
  ]);
}

function buildXhsSlidePrompt({ packTitle, publishTitle, slide }) {
  return compactJoin([
    `生成小红书 4 页组图中的${slide.pageLabel || "当前页"}`,
    packTitle ? `组图主题：${packTitle}` : "",
    publishTitle ? `发布标题：${publishTitle}` : "",
    slide.title ? `本页标题：${slide.title}` : "",
    slide.copy ? `本页画面文案：${slide.copy}` : "",
    slide.visualDirection ? `视觉方向：${slide.visualDirection}` : "",
    slide.style ? `风格：${slide.style}` : "",
    slide.composition ? `构图：${slide.composition}` : "",
    "竖版 3:4，信息层级清楚，适合小红书滑动阅读，避免英文文字和广告海报感",
  ]);
}

function buildWechatLongImagePrompt({ publishTitle, intro, outline, visualDirection, style, composition }) {
  return compactJoin([
    `生成公众号长图，标题是“${publishTitle}”`,
    intro ? `导语：${intro}` : "",
    Array.isArray(outline) && outline.length ? `内容结构：${outline.join(" / ")}` : "",
    visualDirection ? `视觉方向：${visualDirection}` : "",
    style ? `风格：${style}` : "",
    composition ? `构图：${composition}` : "",
    "9:16 竖版长图，中文信息层级清楚，文字密度适中，避免夸大承诺和硬广感",
  ]);
}

function normalizeGeneratedXhsCarouselPack(raw) {
  const source = raw?.carouselPack && typeof raw.carouselPack === "object" ? raw.carouselPack : raw;
  if (!source || typeof source !== "object") {
    throw new Error("AI 内容生成结果不是有效对象。");
  }
  const rawSlides = Array.isArray(source.slides) ? source.slides : [];
  if (rawSlides.length !== XHS_CAROUSEL_SLIDE_COUNT) {
    throw new Error(`AI 内容生成结果必须包含 ${XHS_CAROUSEL_SLIDE_COUNT} 页组图。`);
  }
  const publishCaption = getRequiredText(source, "publishCaption", "发布文案", 900);
  const pack = {
    title: getRequiredText(source, "title", "组图方案标题", 120),
    publishTitle: getRequiredText(source, "publishTitle", "发布标题", 120),
    publishCaption,
    caption: getText(source, "caption", 500) || publishCaption,
    aspectRatio: getText(source, "aspectRatio", 16) || "3:4",
    slides: rawSlides.map((slide, index) => {
      const remixBrief = normalizeRemixBrief(slide?.remixBrief || source.remixBrief);
      const sourceLearningApplied = Array.isArray(slide?.sourceLearningApplied)
        ? slide.sourceLearningApplied
            .map((item) => String(item || "").replace(/\s+/g, " ").trim().slice(0, 80))
            .filter(Boolean)
            .slice(0, 6)
        : [];
      const normalizedSlide = {
        pageLabel: getText(slide, "pageLabel", 24) || `第 ${index + 1} 张`,
        pageRole: getText(slide, "pageRole", 80),
        title: getRequiredText(slide, "title", `第 ${index + 1} 页标题`, 120),
        copy: getRequiredText(slide, "copy", `第 ${index + 1} 页文案`, 500),
        contentGoal: getText(slide, "contentGoal", 200),
        visualDirection: getRequiredText(slide, "visualDirection", `第 ${index + 1} 页视觉方向`, 300),
        style: getText(slide, "style", 160) || "小红书组图封面页，清晰、真实、适合收藏",
        composition: getText(slide, "composition", 500) || "竖版信息图，标题清楚，留白充足，画面有连续组图统一性。",
        prompt: getText(slide, "prompt", 1800),
        aspectRatio: getText(slide, "aspectRatio", 16) || getText(source, "aspectRatio", 16) || "3:4",
        sourceLearningApplied,
        previewUrl: "",
      };
      if (remixBrief) {
        normalizedSlide.remixBrief = remixBrief;
      }
      return normalizedSlide;
    }),
  };
  const packRemixBrief = normalizeRemixBrief(source.remixBrief);
  if (packRemixBrief) {
    pack.remixBrief = packRemixBrief;
  }
  const sourceTemplate = normalizeSourceTemplate(source.sourceTemplate);
  if (sourceTemplate) {
    pack.sourceTemplate = sourceTemplate;
  }
  pack.slides = pack.slides.map((slide) => ({
    ...slide,
    prompt: slide.prompt || buildXhsSlidePrompt({ packTitle: pack.title, publishTitle: pack.publishTitle, slide }),
  }));
  return pack;
}

function compactRemixText(value, maxLength = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeNonNegNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(max, Math.floor(num));
}

function normalizeExcellentBoardValue(value) {
  const board = compactRemixText(value, 40);
  if (board === "xhs_hot" || board === "ecommerce_hot") return board;
  return "";
}

function normalizeContentModeValue(value) {
  const mode = compactRemixText(value, 40);
  if (mode === "smart" || mode === "existing_idea" || mode === "custom") return mode;
  return "";
}

function normalizeRemixBrief(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const learningFocus = Array.isArray(raw.learningFocus)
    ? raw.learningFocus.map((item) => compactRemixText(item, 40)).filter(Boolean).slice(0, 8)
    : [];
  const sourceLearningApplied = Array.isArray(raw.sourceLearningApplied)
    ? raw.sourceLearningApplied.map((item) => compactRemixText(item, 80)).filter(Boolean).slice(0, 6)
    : [];
  const platformVisualGuidance = compactRemixText(raw.platformVisualGuidance, 220);
  const brief = {
    sourceType: compactRemixText(raw.sourceType, 40) || "excellent_content",
    sourceNoteId: compactRemixText(raw.sourceNoteId, 80),
    sourceTitle: compactRemixText(raw.sourceTitle, 120),
    sourceBoard: normalizeExcellentBoardValue(raw.sourceBoard),
    sourceCategoryPath: compactRemixText(raw.sourceCategoryPath, 180),
    sourceIndustryPath: compactRemixText(raw.sourceIndustryPath, 180),
    sourceImageCount: normalizeNonNegNumber(raw.sourceImageCount, 99),
    sourceReadCount: normalizeNonNegNumber(raw.sourceReadCount, 1e12),
    sourceEngagementCount: normalizeNonNegNumber(raw.sourceEngagementCount, 1e12),
    contentMode: normalizeContentModeValue(raw.contentMode),
    contentDirection: compactRemixText(raw.contentDirection, 200),
    targetAudience: compactRemixText(raw.targetAudience, 80),
    userScene: compactRemixText(raw.userScene, 120),
    trendUsed: Boolean(raw.trendUsed),
    trendTitle: compactRemixText(raw.trendTitle, 120),
    learningFocus,
    pageRole: compactRemixText(raw.pageRole, 80),
    pageTask: compactRemixText(raw.pageTask, 200),
    pageTitle: compactRemixText(raw.pageTitle, 120),
    pageCopy: compactRemixText(raw.pageCopy, 300),
    contentGoal: compactRemixText(raw.contentGoal, 200),
    sourceLearningApplied,
    // Separate from sourceLearningApplied — platform defaults must not look like reference-image learning.
    platformVisualGuidance,
    originalityGuard: compactRemixText(raw.originalityGuard, 400),
  };
  // Never allow sourceUrl, cookies, tokens, image URLs, or arbitrary secrets into prompt metadata.
  delete brief.sourceUrl;
  delete brief.cookie;
  delete brief.token;
  delete brief.authorization;
  delete brief.imageUrls;
  delete brief.sourceImageUrls;
  return brief;
}

function normalizeSourceTemplate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const noteId = compactRemixText(raw.noteId || raw.sourceNoteId, 80);
  const board = normalizeExcellentBoardValue(raw.board || raw.source);
  return {
    noteId,
    title: compactRemixText(raw.title, 120),
    // sourceUrl stays in business payload only; Image Prompt Engine must not use it.
    sourceUrl: compactRemixText(raw.sourceUrl || raw.noteUrl, 300),
    source: board || compactRemixText(raw.source, 40) || "xhs_hot",
    board,
    contentSource: compactRemixText(raw.contentSource, 40),
  };
}

function normalizeGeneratedImageConceptMetadata(raw) {
  const source = raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : raw;
  if (!source || typeof source !== "object") {
    throw new Error("AI 内容生成结果不是有效对象。");
  }
  const metadata = {
    title: getRequiredText(source, "title", "标题", 120),
    caption: getRequiredText(source, "caption", "朋友圈文案", 900),
    visualDirection: getRequiredText(source, "visualDirection", "视觉方向", 300),
    style: getText(source, "style", 160) || "真实、清晰、克制、有社交媒体质感",
    composition: getText(source, "composition", 500) || "主体明确，信息留白充足，品牌露出自然。",
    prompt: getText(source, "prompt", 1800),
  };
  metadata.prompt = metadata.prompt || buildMomentsPrompt(metadata);
  return metadata;
}

function normalizeGeneratedWechatLongImagePack(raw) {
  const source = raw?.wechatPack && typeof raw.wechatPack === "object" ? raw.wechatPack : raw;
  if (!source || typeof source !== "object") {
    throw new Error("AI 内容生成结果不是有效对象。");
  }
  const intro = getRequiredText(source, "intro", "文章导语", 700);
  const positioning = getRequiredText(source, "positioning", "长图定位", 500);
  const cta = getRequiredText(source, "cta", "CTA", 260);
  const outline = (Array.isArray(source.outline)
    ? source.outline.map((item) => normalizeChineseCopy(String(item || "").trim()).slice(0, 220)).filter(Boolean)
    : [])
    .slice(0, 5);
  for (const fallback of [positioning, cta, intro]) {
    if (outline.length >= 3) break;
    const item = normalizeChineseCopy(fallback).slice(0, 220);
    if (item && !outline.includes(item)) outline.push(item);
  }
  if (outline.length < 3) {
    throw new Error("AI 内容生成结果必须包含 3 到 5 条公众号长图大纲。");
  }
  const pack = {
    title: getRequiredText(source, "title", "公众号长图方案标题", 120),
    publishTitle: getRequiredText(source, "publishTitle", "发布标题", 120),
    intro,
    outline,
    positioning,
    cta,
    visualDirection: getRequiredText(source, "visualDirection", "视觉方向", 300),
    style: getText(source, "style", 160) || "专业、清晰、克制、可信",
    composition: getText(source, "composition", 600) || "9:16 竖版长图，顶部标题区，中段信息摘要区，底部轻 CTA 区。",
    prompt: getText(source, "prompt", 2200),
    previewUrl: "",
  };
  pack.prompt = pack.prompt || buildWechatLongImagePrompt(pack);
  return pack;
}

function readContentAssets(source) {
  if (!source || typeof source !== "object") return {};
  const assets =
    source.contentAssets ||
    source.content_assets ||
    source.assetPack ||
    source.asset_pack ||
    source.contentPack ||
    source.content_pack ||
    {};
  return assets && typeof assets === "object" && !Array.isArray(assets) ? assets : {};
}

function normalizeIdeaContentAssets(raw) {
  const assets = readContentAssets(raw);
  const normalized = {};
  const moments = assets.moments || assets.momentsImage || assets.moments_image || assets.socialImage || assets.social_image;
  const xhsCarousel = assets.xhsCarousel || assets.xhs_carousel || assets.carousel || assets.xhs;
  const wechatLongImage =
    assets.wechatLongImage || assets.wechat_long_image || assets.wechat || assets.officialAccountLongImage || assets.official_account_long_image;

  if (moments && typeof moments === "object") {
    normalized.moments = normalizeGeneratedImageConceptMetadata(moments);
  }
  if (xhsCarousel && typeof xhsCarousel === "object") {
    normalized.xhsCarousel = normalizeGeneratedXhsCarouselPack(xhsCarousel);
  }
  if (wechatLongImage && typeof wechatLongImage === "object") {
    normalized.wechatLongImage = normalizeGeneratedWechatLongImagePack(wechatLongImage);
  }
  return normalized;
}

function hasCompleteIdeaContentAssets(idea) {
  const assets = normalizeIdeaContentAssets(idea);
  return Boolean(assets.moments && assets.xhsCarousel && assets.wechatLongImage);
}

function requireIdeaContentAssets(idea, assetKey, label) {
  const assets = normalizeIdeaContentAssets(idea);
  const asset = assets[assetKey];
  if (!asset) {
    throw new Error(`当前选题缺少趋势分析时生成的${label}内容资产，请先重新生成趋势分析或重新生成选题。`);
  }
  return asset;
}

function buildImageConceptMetadataFromIdea(idea) {
  return requireIdeaContentAssets(idea, "moments", "朋友圈图");
}

function buildXhsCarouselPackFromIdea(idea) {
  return requireIdeaContentAssets(idea, "xhsCarousel", "小红书组图");
}

function buildWechatLongImagePackFromIdea(idea) {
  return requireIdeaContentAssets(idea, "wechatLongImage", "公众号长图");
}

module.exports = {
  XHS_CAROUSEL_SLIDE_COUNT,
  XHS_VISUAL_STYLE_PRESETS,
  WECHAT_LONG_IMAGE_TEMPLATES,
  applyXhsCreativeDirection,
  applyWechatCreativeDirection,
  normalizeGeneratedXhsCarouselPack,
  normalizeRemixBrief,
  normalizeSourceTemplate,
  normalizeGeneratedImageConceptMetadata,
  normalizeGeneratedWechatLongImagePack,
  normalizeIdeaContentAssets,
  hasCompleteIdeaContentAssets,
  buildImageConceptMetadataFromIdea,
  buildXhsCarouselPackFromIdea,
  buildWechatLongImagePackFromIdea,
};
