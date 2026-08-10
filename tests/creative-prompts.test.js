const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  applyWechatCreativeDirection,
  applyXhsCreativeDirection,
  normalizeGeneratedWechatLongImagePack,
  normalizeGeneratedXhsCarouselPack,
} = require("../src/server/ai/content-service");
const { applyStructuredImagePrompt } = require("../src/server/ai/image-jobs");

const brand = {
  name: "Lumi 日常研究所",
  profileType: "brand",
  industry: "生活方式",
  audience: "城市通勤女性",
  product: "轻量通勤随行包",
  assetTags: ["通勤", "轻量", "日常质感"],
};

function buildCarouselPack(extra = {}) {
  return {
    ...normalizeGeneratedXhsCarouselPack({
      title: "通勤收纳组图",
      publishTitle: "通勤包怎么装才不乱",
      publishCaption: "四页讲清通勤包收纳方法。",
      caption: "从痛点到清单的完整组图。",
      slides: [1, 2, 3, 4].map((page) => ({
        pageLabel: `第 ${page} 张`,
        title: `通勤收纳重点 ${page}`,
        copy: `这是第 ${page} 页需要表达的核心内容。`,
        visualDirection: "真实通勤场景",
      })),
    }),
    ...extra,
  };
}

test("xhs creative direction applies the selected visual system and four distinct page roles", () => {
  const pack = applyXhsCreativeDirection(buildCarouselPack(), {
    stylePreset: "review",
    brand,
    idea: { title: "通勤包真实测评" },
    aspectRatio: "3:4",
  });

  assert.equal(pack.creativeStyle, "review");
  assert.deepEqual(pack.slides.map((slide) => slide.pageRole), ["停留封面", "场景代入", "价值证明", "收藏收束"]);
  assert.match(pack.slides[0].prompt, /产品测评型/);
  assert.match(pack.slides[0].prompt, /中性自然光/);
  assert.match(pack.slides[0].prompt, /35mm|微距/);
  assert.match(pack.slides[0].prompt, /Lumi 日常研究所/);
  assert.match(pack.slides[0].prompt, /未提供 Logo 参考图时不要虚构 Logo/);
  assert.match(pack.slides[0].prompt, /错误手指/);
  assert.match(pack.slides[3].prompt, /收藏收束/);
  assert.notEqual(pack.slides[0].prompt, pack.slides[1].prompt);
});

test("xhs auto style selects a content-aware preset", () => {
  const pack = applyXhsCreativeDirection(buildCarouselPack(), {
    stylePreset: "auto",
    brand,
    idea: { title: "通勤包开箱实测与细节对比" },
  });

  assert.equal(pack.creativeStyle, "review");
});

test("excellent remix source mode preserves its original prompts and composition", () => {
  const original = buildCarouselPack({
    remixBrief: { sourceType: "excellent_content", sourceNoteId: "note-1" },
  });
  const originalPrompt = original.slides[0].prompt;
  const originalComposition = original.slides[0].composition;

  const pack = applyXhsCreativeDirection(original, {
    stylePreset: "source",
    brand,
    idea: { title: "优秀案例改编" },
  });

  assert.equal(pack.creativeStyle, "source");
  assert.equal(pack.slides[0].prompt, originalPrompt);
  assert.equal(pack.slides[0].composition, originalComposition);
});

test("wechat creative direction builds a mobile-readable template without inventing data", () => {
  const base = normalizeGeneratedWechatLongImagePack({
    title: "通勤方法长图",
    publishTitle: "上班前五分钟，整理好今天的通勤包",
    intro: "用一套简单步骤减少早高峰的手忙脚乱。",
    outline: ["先按使用频率分区", "固定高频物品位置", "为雨天留一个应急区"],
    positioning: "通勤收纳教程",
    cta: "收藏备用",
    visualDirection: "真实通勤场景与步骤卡片",
  });
  const pack = applyWechatCreativeDirection(base, {
    template: "tutorial",
    brand,
    idea: { title: "通勤包收纳教程" },
    aspectRatio: "9:21",
  });

  assert.equal(pack.template, "tutorial");
  assert.equal(pack.templateLabel, "干货教程");
  assert.equal(pack.platform, "wechat");
  assert.match(pack.prompt, /9:21 竖版/);
  assert.doesNotMatch(pack.prompt, /9:16 竖版/);
  assert.match(pack.prompt, /连续编号/);
  assert.match(pack.prompt, /禁止生成长段正文/);
  assert.match(pack.prompt, /错误数据、伪造来源/);
  assert.match(pack.composition, /准备事项/);
});

test("the final structured image prompt keeps the selected creative settings", () => {
  const carouselPack = applyXhsCreativeDirection(buildCarouselPack(), {
    stylePreset: "editorial",
    brand,
    idea: { title: "通勤美学" },
  });
  const xhsMetadata = applyStructuredImagePrompt(
    {
      title: carouselPack.slides[0].title,
      slideIndex: 0,
      pageLabel: carouselPack.slides[0].pageLabel,
      style: carouselPack.slides[0].style,
      composition: carouselPack.slides[0].composition,
      creativeDirection: carouselPack.slides[0].creativeDirection,
      prompt: carouselPack.slides[0].prompt,
    },
    { brand, idea: { title: "通勤美学" } },
  );
  assert.match(xhsMetadata.prompt, /【创作设置】/);
  assert.match(xhsMetadata.prompt, /杂志编辑感/);
  assert.match(xhsMetadata.prompt, /非对称编辑网格/);
  assert.match(xhsMetadata.prompt, /停留封面/);

  const wechatPack = applyWechatCreativeDirection(
    normalizeGeneratedWechatLongImagePack({
      title: "通勤报告",
      publishTitle: "城市通勤观察",
      intro: "从真实场景观察通勤变化。",
      outline: ["关键现象", "原因拆解", "行动建议"],
      positioning: "行业趋势报告",
      cta: "保存报告",
      visualDirection: "专业报告长图",
    }),
    { template: "report", brand, idea: { title: "城市通勤观察" } },
  );
  const wechatMetadata = applyStructuredImagePrompt(wechatPack, { brand, idea: { title: "城市通勤观察" } });
  assert.equal(wechatMetadata.platform, "wechat");
  assert.match(wechatMetadata.prompt, /平台：微信公众号/);
  assert.doesNotMatch(wechatMetadata.prompt, /平台：小红书/);
  assert.match(wechatMetadata.prompt, /行业报告/);
  assert.match(wechatMetadata.prompt, /图表只表现输入中明确存在的数据/);
  assert.match(wechatMetadata.prompt, /内容大纲：1\. 关键现象/);
});

// 迁移说明：本用例原断言 public/app.js 的创作设置接线与 public/styles.css 的
// 趋势面板滚动样式，二者已随旧前端删除，改为断言新实现：
//   frontend/src/features/ideas/views/IdeasView.vue（创作设置控件，2026-08-05
//     不可达的 GenerationView 已删除，真实入口为内容选题页）
//   frontend/src/features/generation/composables/useIdeaGeneration.ts（请求体接线，
//     2026-08-05 与内容选题对话框共享的状态机抽取）
//   frontend/src/features/trends/views/TrendsView.vue（趋势结果面板样式）
// 映射变化：
// - 旧 per-idea 折叠面板（data-toggle-creative-settings / data-creative-field /
//   getIdea*Selection(ideaIndex)）→ 新实现为内容选题页按选题维度的创作设置
//   （idea-creative-style / idea-creative-template select + 比例网格），并透传
//   进生成请求体（useIdeaGeneration 中 preview/slide/wechat 请求体）。
// - 趋势面板保留独立滚动，但高度按真实 top 动态计算，避免品牌行换行后
//   固定视口偏移裁掉第 10 条趋势。
test("frontend wires the creative settings into generation requests and keeps trend results scrollable", () => {
  const ideasSource = fs.readFileSync(
    path.join(__dirname, "../frontend/src/features/ideas/views/IdeasView.vue"),
    "utf8",
  );
  const generationComposableSource = fs.readFileSync(
    path.join(__dirname, "../frontend/src/features/generation/composables/useIdeaGeneration.ts"),
    "utf8",
  );
  const trendsSource = fs.readFileSync(
    path.join(__dirname, "../frontend/src/features/trends/views/TrendsView.vue"),
    "utf8",
  );

  // 创作设置控件存在且分别覆盖小红书 / 公众号两个字段（按选题序号维度）
  assert.match(
    ideasSource,
    /<select[^>]*data-test="`idea-creative-style-\$\{index\}`"[^>]*>/,
  );
  assert.match(
    ideasSource,
    /<select[^>]*data-test="`idea-creative-template-\$\{index\}`"[^>]*>/,
  );
  assert.match(ideasSource, /XHS_CREATIVE_STYLE_OPTIONS/);
  assert.match(ideasSource, /WECHAT_TEMPLATE_OPTIONS/);
  // 选择结果必须透传进真实生成请求体（预览与逐页生成都要带上）
  assert.match(generationComposableSource, /visualStylePreset:\s*xhsStylePreset\.value/);
  assert.equal(
    (generationComposableSource.match(/visualStylePreset:\s*xhsStylePreset\.value/g) || []).length >= 2,
    true,
  );
  assert.match(generationComposableSource, /wechatTemplate:\s*wechatTemplate\.value/);

  // 趋势结果面板仍是独立滚动容器，并使用动态剩余高度而非固定偏移。
  assert.match(trendsSource, /data-test="trend-scroll-panel"/);
  assert.match(trendsSource, /overflow-y:\s*auto/);
  assert.match(trendsSource, /window\.innerHeight - documentTop - 24/);
  assert.doesNotMatch(trendsSource, /max-height:\s*calc\(100vh - 250px\)/);
  assert.match(trendsSource, /\.trend-right-panel\s*\{[^}]*flex:\s*1[^}]*flex-direction:\s*column/s);
  assert.match(trendsSource, /\.trend-right-panel\s*\{[^}]*min-width:\s*0/s);
});
