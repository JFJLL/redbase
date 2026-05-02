const { normalizeChineseCopy, pickVariant } = require("../utils");
function buildMomentsGenerationPayload(job) {
  return {
    ...job.metadata,
    title: job.metadata.title || "朋友圈图方案",
    imageUrl: job.imageUrl || "",
    previewUrl: job.imageUrl || "",
    model: job.model,
    provider: job.provider,
    caption: job.metadata.caption || "",
  };
}

function buildGeneratedAssetPayload(job) {
  return {
    ...job.metadata,
    imageUrl: job.imageUrl || "",
    previewUrl: job.imageUrl || "",
    model: job.model,
    provider: job.provider,
  };
}

function getAssetPalette(brand) {
  return String(brand.industry || "").toLowerCase().includes("beauty") || String(brand.industry || "").includes("美")
    ? ["#f06b93", "#ffd7e2", "#8b4f76"]
    : ["#ef4c82", "#ffb25a", "#342a62"];
}

function buildWechatLongImagePack({ brand, trend, idea }) {
  const palette = getAssetPalette(brand);
  const seed = `${brand.name}|${trend.title}|${idea.title}|wechat`;
  const titleTemplate = pickVariant(`${seed}|title`, [
    () => `${idea.title}｜公众号长图版`,
    () => `${trend.title}下的品牌内容切口`,
    () => `${brand.name}的${idea.title}长图方案`,
    () => `从${trend.title}说起：${idea.title}`,
  ]);
  const introTemplate = pickVariant(`${seed}|intro`, [
    () => `这篇长图不直接复述热点，而是从“${trend.title}”背后的用户需求切入，把${brand.name}能承接的场景、观点和行动建议讲完整。`,
    () => `如果把“${trend.title}”写成公众号内容，重点不是追赶讨论度，而是让读者看见${brand.name}和这个议题之间真实、具体的关系。`,
    () => `围绕“${idea.title}”，这张长图先建立观点，再展开用户场景，最后把${idea.brandFit}转成可阅读、可转发的品牌表达。`,
    () => `这套内容适合用更沉稳的公众号语气展开：用${trend.title}打开话题，用${brand.name}补上解决思路和审美判断。`,
  ]);
  const positioningTemplate = pickVariant(`${seed}|positioning`, [
    () => `适合作为公众号文章头图或中段总结图，用清晰标题、分层信息和留白感承接长阅读。`,
    () => `更像一张文章里的观点摘要图，负责把热点、用户场景和品牌价值压缩到一屏内。`,
    () => `适合放在公众号开头建立阅读预期，也适合作为文章结尾的收藏型信息卡。`,
    () => `长图语气偏专业克制，重点是可读性、信息秩序和品牌质感，而不是强营销海报。`,
  ]);
  const ctaTemplate = pickVariant(`${seed}|cta`, [
    () => `建议CTA：收藏这份${trend.title}内容思路，后续可继续拆解${brand.name}在该场景下的具体方案。`,
    () => `建议CTA：如果你也在关注${idea.audience}的真实需求，可以把这张长图作为选题参考保存下来。`,
    () => `建议CTA：从一个热点开始，继续观察${brand.name}如何把趋势变成更具体的内容资产。`,
    () => `建议CTA：保存这张长图，下次做${brand.industry || "品牌"}内容策划时可以直接复用结构。`,
  ]);

  return {
    title: normalizeChineseCopy(titleTemplate()),
    publishTitle: normalizeChineseCopy(pickVariant(`${seed}|publish`, [
      () => `${trend.title}之下，${brand.name}更值得被看见的内容切口`,
      () => `${idea.title}：一个适合${brand.name}展开的公众号选题`,
      () => `从${trend.title}到${brand.name}，这条内容可以这样讲`,
      () => `${brand.name}如何把${trend.title}转成可读的品牌内容`,
    ])()),
    intro: normalizeChineseCopy(introTemplate()),
    outline: [
      normalizeChineseCopy(`先解释“${trend.title}”击中了哪类用户情绪、使用场景或消费判断`),
      normalizeChineseCopy(`再说明${brand.name}和这个议题的真实关系，避免生硬贴热点`),
      normalizeChineseCopy(`把${idea.brandFit}拆成观点、场景、方法或案例，让读者能顺着读下去`),
      normalizeChineseCopy(`最后给出轻量行动建议，引导收藏、评论或继续了解${brand.name}`),
    ],
    positioning: normalizeChineseCopy(positioningTemplate()),
    cta: normalizeChineseCopy(ctaTemplate()),
    prompt: normalizeChineseCopy(`为微信公众号文章生成一张真正的竖版长图，主题围绕“${idea.title}”，热点背景是“${trend.title}”，品牌为${brand.name}。长图需要适合微信文章内嵌或朋友圈转发阅读，整体长度至少相当于 3 个手机屏幕的纵向阅读内容，不要做成单屏海报、单张封面或小红书封面。版式不要套固定模板，请根据选题内容自由组织为连续阅读的长图，可以是观点解析、故事叙述、清单总结、步骤拆解、对比说明、场景展开或案例化表达。画面需要有自然的阅读节奏：开头能抓住主题，中段有足够信息展开，结尾有总结、行动建议、轻 CTA 或品牌落点；但不要强行做成固定的“三段式/三栏/三模块”。信息层级要清楚，段落之间有呼吸感和视觉分隔，留白充足。文字不要密密麻麻，不要生成大段小字，适合用短标题、短句、编号、引用、图标化信息块或少量关键句来呈现。品牌资料：${brand.knowledgeBase || "暂无额外资料"}。需要自然体现${idea.brandFit}，整体风格沉稳、专业、清晰、有公众号内容质感，避免强广告感、促销感和复杂杂乱排版。`),
    previewUrl: "",
  };
}

function buildXhsCarouselPack({ brand, trend, idea }) {
  const palette = getAssetPalette(brand);
  const seed = `${brand.name}|${trend.title}|${idea.title}|carousel`;
  const normalizedIdeaTitle = normalizeChineseCopy(String(idea.title || trend.title || "今天的生活灵感").replace(/｜/g, "，"));
  const slideCopySets = [
    [
      `不是自律到满分才叫晨间仪式感。能在出门前认真喝一杯、吃一点，把自己照顾好，就已经是在给一天一个好开头。`,
      `很多人的早晨都很赶：消息在催、通勤在催、脑子还没醒。越是这种时候，越需要一个不用费力也能稳定下来的小动作。`,
      `${brand.name}适合放进这样的早晨里：口感干净，营养扎实，不需要复杂准备，也能让早餐多一点被认真对待的感觉。`,
      `把这几分钟留给自己。今天不一定要很完美，但可以从一杯更舒服的早餐开始。`,
    ],
    [
      `早晨过得粗糙，后面一整天都容易被拖着走。给自己一点固定的小秩序，状态真的会不一样。`,
      `可以不用很盛大：洗漱后开窗、准备早餐、倒一杯牛奶，坐下来吃完再出门。简单，但很能把人拉回自己的节奏。`,
      `如果早餐想兼顾省心和品质，${brand.name}这种不用额外加工的选择，会比临时凑合更容易坚持。`,
      `真正的仪式感不是摆拍，是你愿意每天给自己留一点被照顾的时间。`,
    ],
    [
      `你有没有发现，早上吃得越随便，越容易一整天都在补救状态。`,
      `把早餐变简单一点，不代表降低标准。少一点匆忙，多一点稳定，反而更容易长期坚持。`,
      `${brand.name}的意义不只是“喝牛奶”，而是让早晨多一个可靠、干净、轻负担的营养选择。`,
      `先照顾好早上的自己，后面的工作、通勤和生活，才更有余地慢慢展开。`,
    ],
  ];
  const slideCopies = pickVariant(`${seed}|copies`, slideCopySets);
  const slides = [
    {
      pageLabel: "第 1 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s1`, [
        () => `${trend.title}为什么和你有关`,
        () => `${idea.title}，先看这个切口`,
        () => `这个问题，很多人都忽略了`,
      ])()),
      copy: normalizeChineseCopy(slideCopies[0]),
      prompt: normalizeChineseCopy(`生成一套适合小红书发布的 4 页组图中的第1页，围绕“${idea.title}”，结合热点“${trend.title}”和品牌${brand.name}。第1页需要像真实小红书笔记封面，有明确点击理由和强钩子，但不要像广告海报或品牌PPT。可以用问题、反差、情绪共鸣、避坑提醒、清单标题或趋势判断来组织封面。画面要适合滑动阅读的开场，文字短、层级清楚，品牌露出自然，不要促销感。`),
    },
    {
      pageLabel: "第 2 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s2`, [
        () => "先把场景说具体",
        () => "真正触发共鸣的是这里",
        () => "很多人卡在这一步",
      ])()),
      copy: normalizeChineseCopy(slideCopies[1]),
      prompt: normalizeChineseCopy(`生成小红书 4 页组图中的第2页，承接第1页继续展开“${idea.title}”。这一页不要固定成某一种模板，可以根据选题选择用户场景、痛点拆解、误区提醒、前后对比、步骤教程、测评观察或故事化表达。重点是让${idea.audience}看到自己的真实生活、消费判断或情绪状态，画面有代入感，文字简洁，信息不要堆满。`),
    },
    {
      pageLabel: "第 3 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s3`, [
        () => "把方法讲到具体处",
        () => "这里才是关键细节",
        () => "给一个可参考的做法",
      ])()),
      copy: normalizeChineseCopy(slideCopies[2]),
      prompt: normalizeChineseCopy(`生成小红书 4 页组图中的第3页，继续展开具体价值。不要固定成品牌解决方案页，可以根据内容选择方法清单、细节放大、对比说明、体验测评、趋势解读或案例化表达。需要自然体现${brand.name}与选题的关系，重点表现${idea.brandFit}，但不要硬广，不要把画面做成促销海报。`),
    },
    {
      pageLabel: "第 4 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s4`, [
        () => "最后给你一个总结",
        () => "这页适合收藏",
        () => "可以从这里开始试试",
      ])()),
      copy: normalizeChineseCopy(slideCopies[3]),
      prompt: normalizeChineseCopy(`生成小红书 4 页组图中的第4页，作为整组内容的自然收尾。可以做收藏清单、总结观点、行动建议、轻互动提问、品牌落点或下一步建议，但不要固定成强CTA。画面要和前3页风格统一，适合用户保存、评论或转发；文字短、有重点，品牌${brand.name}自然露出，避免广告感和复杂排版。`),
    },
  ].map((slide, index) => ({
    ...slide,
    previewUrl: "",
  }));
  const captionTemplate = pickVariant(`${seed}|caption`, [
    () => `把早餐认真吃完，把早晨慢慢过好。${brand.name}不用把生活变复杂，只是帮你把一天的开始照顾得更稳一点。`,
    () => `晨间仪式感不一定要很贵、很满、很精致。能坐下来喝一杯牛奶，给身体一点确定的营养，就已经很好。`,
    () => `今天也从一杯${brand.name}开始吧。少一点匆忙，多一点被自己照顾到的感觉。`,
    () => `早上的几分钟，其实很能决定一天的状态。给自己一杯牛奶，也给生活留一点从容。`,
  ]);
  const publishCaptionTemplate = pickVariant(`${seed}|publish`, [
    () => `以前总觉得早晨要很精致才算仪式感。后来发现，能认真吃早餐、慢慢喝完一杯牛奶，就已经是在好好照顾自己。今天也从${brand.name}开始，给身体和心情一点稳定的能量。`,
    () => `早八人的早晨不一定从容，但可以有一个属于自己的小秩序：洗漱、早餐、一杯${brand.name}。不用很复杂，只要让自己被好好照顾到。`,
    () => `把早晨过好，不是为了拍给谁看。只是想在忙起来之前，先给自己一点营养、一点安静，和一点“今天可以慢慢来”的底气。`,
    () => `一杯牛奶、一份早餐、几分钟留白。${brand.name}放进晨间日常里，刚好让“好好开始一天”变得更简单。`,
  ]);

  return {
    title: normalizeChineseCopy(`${idea.title}｜小红书组图方案`),
    publishTitle: normalizeChineseCopy(pickVariant(`${seed}|publishTitle`, [
      () => `${normalizedIdeaTitle}，从一杯${brand.name}开始`,
      () => `早晨再赶，也想认真喝完这杯牛奶`,
      () => `不是自律，是给早上的自己一点照顾`,
      () => `把早餐吃好，真的会让一天轻一点`,
    ])()),
    publishCaption: normalizeChineseCopy(publishCaptionTemplate()),
    caption: normalizeChineseCopy(captionTemplate()),
    slides,
  };
}

function normalizeXhsCarouselSlideForJob(input, fallback, slideIndex) {
  const source = input && typeof input === "object" ? input : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const pageLabel = String(source.pageLabel || base.pageLabel || `第 ${slideIndex + 1} 张`).slice(0, 24);
  const title = normalizeChineseCopy(String(source.title || base.title || pageLabel).slice(0, 120));
  const copy = normalizeChineseCopy(String(source.copy || base.copy || "").slice(0, 500));
  const visualDirection = normalizeChineseCopy(String(source.visualDirection || base.visualDirection || title).slice(0, 300));
  const style = String(source.style || base.style || "xiaohongshu carousel cover page").slice(0, 160);
  const composition = normalizeChineseCopy(
    String(
      source.composition ||
        base.composition ||
        `小红书组图${slideIndex + 1}/4，竖版3:4，标题清晰，画面有连续组图统一性`,
    ).slice(0, 500),
  );
  const prompt = normalizeChineseCopy(String(source.prompt || base.prompt || "").trim());
  return {
    ...base,
    ...source,
    pageLabel,
    title,
    copy,
    visualDirection,
    style,
    composition,
    prompt,
  };
}

function buildSvgPreview({ brandName, title, subtitle, palette }) {
  const safeTitle = String(title || "");
  const line1 = safeTitle.slice(0, 14);
  const line2 = safeTitle.slice(14, 28);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="840" height="1120" viewBox="0 0 840 1120">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${palette[0]}"/>
          <stop offset="55%" stop-color="${palette[2]}"/>
          <stop offset="100%" stop-color="#17162a"/>
        </linearGradient>
      </defs>
      <rect width="840" height="1120" rx="48" fill="url(#bg)"/>
      <circle cx="640" cy="220" r="160" fill="${palette[1]}" fill-opacity="0.16"/>
      <circle cx="220" cy="860" r="210" fill="${palette[1]}" fill-opacity="0.1"/>
      <rect x="72" y="74" width="180" height="58" rx="29" fill="rgba(255,255,255,0.12)"/>
      <text x="102" y="113" font-size="28" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(brandName)}</text>
      <text x="72" y="250" font-size="68" font-weight="700" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(line1)}</text>
      <text x="72" y="328" font-size="68" font-weight="700" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(line2)}</text>
      <text x="72" y="430" font-size="34" fill="${palette[1]}" font-family="Arial, sans-serif">${escapeXml(subtitle)}</text>
      <rect x="72" y="886" width="696" height="160" rx="36" fill="rgba(11,11,21,0.28)" stroke="rgba(255,255,255,0.1)"/>
      <text x="110" y="955" font-size="34" fill="#fff7fb" font-family="Arial, sans-serif">内容资产预览图</text>
      <text x="110" y="1008" font-size="28" fill="#ddd4ea" font-family="Arial, sans-serif">品牌资产 × 热点趋势 × 视觉表达</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeXml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
module.exports = {
  buildMomentsGenerationPayload,
  buildGeneratedAssetPayload,
  getAssetPalette,
  buildWechatLongImagePack,
  buildXhsCarouselPack,
  normalizeXhsCarouselSlideForJob,
  buildSvgPreview,
  escapeXml,
};
