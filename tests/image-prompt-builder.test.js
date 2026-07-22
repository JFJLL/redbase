const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  CONTENT_TYPES,
  buildImagePrompt,
  resolveImagePromptContext,
  shouldSkipStructuredPrompt,
  normalizeContentType,
  inferContentTypeFromMetadata,
} = require("../src/server/ai/image-prompt-builder");
const { applyStructuredImagePrompt } = require("../src/server/ai/image-jobs");

const brand = {
  id: 1,
  name: "晨光手冲",
  industry: "精品咖啡",
  audience: "都市上班族",
  description: "专注办公室与通勤场景的精品咖啡品牌",
  product: "挂耳咖啡",
  goal: "建立品质咖啡心智",
};

const product = "挂耳咖啡";

function assertFiveLayers(prompt) {
  assert.match(prompt, /【视觉目标】/);
  assert.match(prompt, /【品牌调性】/);
  assert.match(prompt, /【场景】/);
  assert.match(prompt, /【构图】/);
  assert.match(prompt, /【负面约束】/);
}

test("buildImagePrompt returns fixed five-layer structure", () => {
  const prompt = buildImagePrompt({
    brand,
    product,
    contentType: "product_seed",
    platform: "xiaohongshu",
    objective: "小红书种草",
  });
  assertFiveLayers(prompt);
  assert.match(prompt, /高级/);
  assert.match(prompt, /自然/);
  assert.match(prompt, /年轻/);
  assert.match(prompt, /可信/);
  assert.match(prompt, /真实生活场景/);
  assert.match(prompt, /非棚拍/);
  assert.match(prompt, /廉价电商图/);
  assert.match(prompt, /塑料质感/);
  assert.match(prompt, /过度修图/);
  assert.match(prompt, /晨光手冲/);
  assert.match(prompt, /挂耳咖啡/);
});

test("same product with different contentType templates yields clearly different prompts", () => {
  const base = { brand, product, platform: "xiaohongshu", objective: "品牌传播" };
  const prompts = Object.fromEntries(
    CONTENT_TYPES.map((contentType) => [contentType, buildImagePrompt({ ...base, contentType })]),
  );

  for (const type of CONTENT_TYPES) {
    assertFiveLayers(prompts[type]);
    assert.match(prompts[type], new RegExp(type));
  }

  for (let i = 0; i < CONTENT_TYPES.length; i += 1) {
    for (let j = i + 1; j < CONTENT_TYPES.length; j += 1) {
      const a = CONTENT_TYPES[i];
      const b = CONTENT_TYPES[j];
      assert.notEqual(prompts[a], prompts[b], `${a} vs ${b} must differ`);
    }
  }

  assert.match(prompts.product_seed, /种草/);
  assert.match(prompts.cover, /封面/);
  assert.match(prompts.poster, /海报/);
  assert.match(prompts.detail_page, /详情页|卖点图/);

  assert.match(prompts.product_seed, /手机随手记录|生活视角/);
  assert.match(prompts.cover, /标题安全区|封面视角/);
  assert.match(prompts.poster, /海报式分区|海报构图/);
  assert.match(prompts.detail_page, /近景|45 度|材质/);
});

test("buildImagePrompt is deterministic for the same inputs", () => {
  const input = {
    brand,
    product,
    contentType: "cover",
    platform: "moments",
    objective: "朋友圈封面",
  };
  assert.equal(buildImagePrompt(input), buildImagePrompt(input));
});

test("normalizeContentType accepts aliases and falls back safely", () => {
  assert.equal(normalizeContentType("product_seed"), "product_seed");
  assert.equal(normalizeContentType("种草图"), "product_seed");
  assert.equal(normalizeContentType("封面"), "cover");
  assert.equal(normalizeContentType("海报"), "poster");
  assert.equal(normalizeContentType("详情页"), "detail_page");
  assert.equal(normalizeContentType("unknown-type"), "product_seed");
});

test("inferContentTypeFromMetadata maps job metadata to templates", () => {
  assert.equal(inferContentTypeFromMetadata({ stylePrompt: "节日海报" }), "poster");
  assert.equal(inferContentTypeFromMetadata({ style: "stylized poster" }), "poster");
  assert.equal(inferContentTypeFromMetadata({ slideIndex: 0, pageLabel: "第 1 张" }), "cover");
  assert.equal(inferContentTypeFromMetadata({ pageLabel: "封面" }), "cover");
  assert.equal(inferContentTypeFromMetadata({ slideIndex: 1 }), "product_seed");
  assert.equal(inferContentTypeFromMetadata({ slideIndex: 3 }), "detail_page");
  assert.equal(
    inferContentTypeFromMetadata({
      intro: "导语",
      outline: ["a", "b", "c"],
      positioning: "长图定位",
    }),
    "detail_page",
  );
  assert.equal(inferContentTypeFromMetadata({ title: "朋友圈图" }), "product_seed");
});

test("resolveImagePromptContext fills product/platform/objective from brand and idea", () => {
  const context = resolveImagePromptContext({
    brand,
    idea: { title: "办公室续杯仪式" },
    metadata: { slideIndex: 0, pageLabel: "封面" },
  });
  assert.equal(context.contentType, "cover");
  assert.equal(context.product, "挂耳咖啡");
  assert.equal(context.objective, "办公室续杯仪式");
  assert.ok(context.platform);
});

test("shouldSkipStructuredPrompt keeps image-edit prompts free-form", () => {
  assert.equal(shouldSkipStructuredPrompt({ editPrompt: "把背景改暖" }), true);
  assert.equal(shouldSkipStructuredPrompt({ skipStructuredPrompt: true }), true);
  assert.equal(shouldSkipStructuredPrompt({ title: "种草图" }), false);
});

test("applyStructuredImagePrompt replaces free AI prompt with engine output", () => {
  const freeform = {
    title: "办公室续杯",
    caption: "今日份提神",
    visualDirection: "AI 自由发挥的淘宝感画面",
    style: "随意",
    composition: "随便摆",
    prompt: "生成一张很随便的电商主图，白底放产品，大大的促销字",
  };
  const next = applyStructuredImagePrompt(freeform, { brand, idea: { title: "办公室续杯" } });
  assertFiveLayers(next.prompt);
  assert.equal(next.promptEngine, "image-prompt-builder");
  assert.equal(next.contentType, "product_seed");
  assert.doesNotMatch(next.prompt, /淘宝感画面|随便摆|促销字/);
  assert.match(next.prompt, /廉价电商图/);
  assert.match(next.prompt, /晨光手冲/);
});

test("applyStructuredImagePrompt preserves edit prompts", () => {
  const editMeta = {
    title: "改图结果",
    editPrompt: "把背景改成暖色木质桌面",
    prompt: "把背景改成暖色木质桌面",
  };
  const next = applyStructuredImagePrompt(editMeta, { brand });
  assert.equal(next.prompt, "把背景改成暖色木质桌面");
  assert.equal(next.promptEngine, undefined);
});

test("explicit contentType on metadata wins over inference", () => {
  const next = applyStructuredImagePrompt(
    {
      title: "朋友圈图",
      prompt: "旧 prompt",
      contentType: "poster",
      platform: "wechat",
      objective: "节日传播",
    },
    { brand },
  );
  assert.equal(next.contentType, "poster");
  assert.match(next.prompt, /海报/);
  assert.match(next.prompt, /微信公众号|社交媒体/);
});
