const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBrandIntelligence,
  buildSafeBrandIntelligenceForMedicineTraffic,
  formatBrandIntelligencePromptLines,
} = require("../src/server/ai/brand-profile-builder");
const {
  buildTrendAnalysisUserPrompt,
  buildTrendAnalysisSystemPrompt,
  TREND_BUCKET_META,
} = require("../src/server/ai/trend-service");

const coffeeBrand = {
  id: 1,
  name: "晨光手冲",
  industry: "精品咖啡",
  audience: "都市上班族",
  description: "专注办公室与通勤场景的精品咖啡品牌",
  product: "挂耳咖啡与手冲豆",
  goal: "在小红书建立可感知的品质咖啡心智",
  knowledgeBase: "主打稳定口感与办公室续杯仪式",
};

const maternalBrand = {
  id: 2,
  name: "小小象",
  industry: "母婴用品",
  audience: "0-3 岁宝宝家长",
  description: "服务育儿日常的母婴品牌",
  product: "婴儿护理套装",
  goal: "成为家长可信赖的育儿内容伙伴",
  knowledgeBase: "关注辅食过渡与亲子照护节奏",
};

function assertIntelligenceShape(intelligence) {
  for (const key of [
    "brand_position",
    "consumer_problem",
    "purchase_trigger",
    "competitive_advantage",
    "content_boundary",
    "tone_style",
  ]) {
    assert.equal(typeof intelligence[key], "string");
    assert.ok(intelligence[key].length > 0, `expected non-empty ${key}`);
  }
}

test("buildBrandIntelligence returns the six required fields", () => {
  const intelligence = buildBrandIntelligence(coffeeBrand);
  assertIntelligenceShape(intelligence);
});

test("same trend context: coffee brand intelligence anchors office scenes", () => {
  const intelligence = buildBrandIntelligence(coffeeBrand);
  assert.match(intelligence.purchase_trigger, /办公室场景/);
  assert.match(
    `${intelligence.brand_position}${intelligence.consumer_problem}${intelligence.purchase_trigger}`,
    /咖啡|提神|续杯/,
  );
  assert.doesNotMatch(intelligence.purchase_trigger, /育儿场景/);
});

test("same trend context: maternal brand intelligence anchors parenting scenes", () => {
  const intelligence = buildBrandIntelligence(maternalBrand);
  assert.match(intelligence.purchase_trigger, /育儿场景/);
  assert.match(
    `${intelligence.brand_position}${intelligence.consumer_problem}${intelligence.purchase_trigger}`,
    /育儿|母婴|家长/,
  );
  assert.doesNotMatch(intelligence.purchase_trigger, /办公室场景/);
});

test("different brands produce clearly different intelligence for the same structure", () => {
  const coffee = buildBrandIntelligence(coffeeBrand);
  const maternal = buildBrandIntelligence(maternalBrand);
  assert.notEqual(coffee.brand_position, maternal.brand_position);
  assert.notEqual(coffee.purchase_trigger, maternal.purchase_trigger);
  assert.notEqual(coffee.competitive_advantage, maternal.competitive_advantage);
  assert.match(coffee.purchase_trigger, /办公室场景/);
  assert.match(maternal.purchase_trigger, /育儿场景/);
});

test("buildBrandIntelligence accepts knowledge_base snake_case alias", () => {
  const intelligence = buildBrandIntelligence({
    industry: "数码科技",
    audience: "远程办公人群",
    product: "效率软件",
    knowledge_base: "一键整理会议纪要",
  });
  assert.match(intelligence.competitive_advantage, /一键整理会议纪要/);
});

test("medicine traffic safe intelligence avoids product efficacy leakage", () => {
  const brand = {
    name: "小快克",
    industry: "儿童健康与家庭用药信息",
    product: "儿童感冒药",
    audience: "儿童家长",
    description: "儿童感冒用药品牌",
    goal: "做好家长沟通内容",
  };
  const safe = buildSafeBrandIntelligenceForMedicineTraffic(brand);
  assertIntelligenceShape(safe);
  assert.match(safe.purchase_trigger, /育儿场景|家长沟通/);
  assert.doesNotMatch(safe.competitive_advantage, /感冒药|疗效|剂量/);
  assert.match(safe.content_boundary, /严禁|不得|不输出/);
});

test("formatBrandIntelligencePromptLines includes judgment criteria", () => {
  const lines = formatBrandIntelligencePromptLines(buildBrandIntelligence(coffeeBrand));
  const block = lines.join("\n");
  assert.match(block, /品牌智能层/);
  assert.match(block, /品牌定位：/);
  assert.match(block, /是否强化品牌优势/);
  assert.match(block, /是否创造新消费场景/);
  assert.match(block, /是否避开竞品红海/);
  assert.match(block, /禁止停留在“是否适合品牌”的模糊判断/);
  assert.doesNotMatch(block, /为什么适合该品牌/);
});

test("trend analysis user prompt injects brand intelligence and new judgment standard", () => {
  const coffeePrompt = buildTrendAnalysisUserPrompt(coffeeBrand, {}, [TREND_BUCKET_META[0]]);
  assert.match(coffeePrompt, /品牌智能层/);
  assert.match(coffeePrompt, /购买触发：.*办公室场景/);
  assert.match(coffeePrompt, /是否强化品牌优势/);
  assert.match(coffeePrompt, /是否创造新消费场景/);
  assert.match(coffeePrompt, /是否避开竞品红海/);
  assert.doesNotMatch(coffeePrompt, /为什么适合该品牌/);

  const maternalPrompt = buildTrendAnalysisUserPrompt(maternalBrand, {}, [TREND_BUCKET_META[0]]);
  assert.match(maternalPrompt, /购买触发：.*育儿场景/);
  assert.doesNotMatch(maternalPrompt, /购买触发：.*办公室场景/);
  assert.notEqual(coffeePrompt, maternalPrompt);
});

test("trend analysis system prompt requires brand-advantage / scene / red-ocean judgment", () => {
  const systemPrompt = buildTrendAnalysisSystemPrompt([TREND_BUCKET_META[0]]);
  assert.match(systemPrompt, /品牌智能层/);
  assert.match(systemPrompt, /是否强化品牌优势/);
  assert.match(systemPrompt, /是否创造新消费场景/);
  assert.match(systemPrompt, /是否避开竞品红海/);
  assert.match(systemPrompt, /禁止停留在“是否适合品牌”的模糊判断/);
});

test("empty or missing brand still returns stable empty-ish intelligence shape", () => {
  assert.deepEqual(buildBrandIntelligence(null), {
    brand_position: "",
    consumer_problem: "",
    purchase_trigger: "",
    competitive_advantage: "",
    content_boundary: "",
    tone_style: "",
  });
  const generic = buildBrandIntelligence({
    industry: "本地生活服务",
    audience: "周边社区居民",
    product: "到店服务",
  });
  assertIntelligenceShape(generic);
});

test("competitive advantage prefers archive facts over invented product claims", () => {
  const withProduct = buildBrandIntelligence({
    industry: "精品咖啡",
    audience: "都市上班族",
    product: "低温冷萃挂耳",
  });
  assert.match(withProduct.competitive_advantage, /低温冷萃挂耳/);
  assert.doesNotMatch(withProduct.competitive_advantage, /第一|认证|功效|医疗级/);

  const sparse = buildBrandIntelligence({
    industry: "精品咖啡",
    audience: "都市上班族",
  });
  assert.match(sparse.competitive_advantage, /办公室|通勤|品牌档案|场景理解/);
  assert.doesNotMatch(sparse.competitive_advantage, /稳定品质|口感记忆点|功效更佳|权威认证/);
});

test("prompt marks brand intelligence as strategy not inventable product facts", () => {
  const prompt = buildTrendAnalysisUserPrompt(coffeeBrand, {}, [TREND_BUCKET_META[0]]);
  assert.match(prompt, /不是可新增的产品事实/);
  assert.match(prompt, /idea\.brandFit 仍只能使用品牌档案明确提供的事实/);
});

test("medicine brands never amplify product or knowledge efficacy as competitive advantage", () => {
  const brand = {
    name: "小快克",
    industry: "儿童药",
    audience: "儿童家长",
    product: "儿童感冒药",
    knowledgeBase: "每盒含对乙酰氨基酚，退热快",
  };
  const intelligence = buildBrandIntelligence(brand);
  assert.doesNotMatch(intelligence.competitive_advantage, /感冒药|对乙酰氨基酚|退热快/);
  assert.doesNotMatch(intelligence.purchase_trigger, /产品钩子|感冒药/);
  assert.match(intelligence.content_boundary, /严禁|功效|剂量/);
  assert.match(intelligence.competitive_advantage, /内容发起者|整理者|共创/);

  const xhsPrompt = buildTrendAnalysisUserPrompt(brand, {}, [TREND_BUCKET_META[0]]);
  assert.doesNotMatch(xhsPrompt, /竞争优势：.*退热快/);
  assert.doesNotMatch(xhsPrompt, /竞争优势：.*对乙酰氨基酚/);
  assert.doesNotMatch(xhsPrompt, /竞争优势：.*感冒药/);
  assert.match(xhsPrompt, /严禁诊疗、剂量、功效/);
});

test("母婴药品 brands match medicine safety path not maternal product hooks", () => {
  const brand = {
    name: "小快克",
    industry: "母婴药品",
    audience: "儿童家长",
    product: "儿童感冒药颗粒",
    knowledgeBase: "退热护理与剂量说明资料",
  };
  const intelligence = buildBrandIntelligence(brand);
  assert.doesNotMatch(intelligence.purchase_trigger, /产品钩子：儿童感冒药/);
  assert.doesNotMatch(intelligence.competitive_advantage, /感冒药|剂量说明|退热护理/);
  assert.match(intelligence.content_boundary, /严禁诊疗、剂量、功效/);

  const safe = buildSafeBrandIntelligenceForMedicineTraffic(brand);
  assert.match(safe.content_boundary, /严禁诊疗、剂量、功效/);
  assert.doesNotMatch(safe.competitive_advantage, /感冒药|剂量/);
});

test("宠物食品 matches pet scenes rather than generic food party scenes", () => {
  const intelligence = buildBrandIntelligence({
    industry: "宠物食品",
    product: "猫粮",
    audience: "猫主人",
  });
  assert.match(intelligence.purchase_trigger, /养宠日常场景|日常喂养/);
  assert.doesNotMatch(intelligence.purchase_trigger, /聚会待客/);
});
