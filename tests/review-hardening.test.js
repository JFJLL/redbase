const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSessionCookie } = require("../src/server/auth/cookies");
const { signAssetUrl, verifySignedAssetRequest } = require("../src/server/assets/signed-urls");
const { DEFAULT_APP_CONFIG, loadAppConfig } = require("../src/server/config");
const helpers = require("../src/server/api/helpers");
const { isAdminUser, findTrendItem, isRenderableGeneration } = helpers;
const { bindRouteScope } = require("../src/server/api/route-scope");
const {
  normalizeGeneratedXhsCarouselPack,
  normalizeGeneratedImageConceptMetadata,
  normalizeGeneratedWechatLongImagePack,
  buildImageConceptMetadataFromIdea,
  buildXhsCarouselPackFromIdea,
  buildWechatLongImagePackFromIdea,
} = require("../src/server/ai/content-service");
const { mapUserRow, mapBrandRow, mapGenerationRow } = require("../src/server/db/repositories/row-mappers");

test("compatible text provider defaults do not expose infrastructure URLs", () => {
  assert.equal(DEFAULT_APP_CONFIG.textProvider.openaiBaseUrl, "");
  assert.equal(DEFAULT_APP_CONFIG.textProvider.anthropicBaseUrl, "");
});

test("production enables secure cookies unless explicitly disabled", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCookieSecure = process.env.COOKIE_SECURE;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.COOKIE_SECURE;
    assert.equal(loadAppConfig().security.cookieSecure, true);

    process.env.COOKIE_SECURE = "false";
    assert.equal(loadAppConfig().security.cookieSecure, false);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousCookieSecure === undefined) {
      delete process.env.COOKIE_SECURE;
    } else {
      process.env.COOKIE_SECURE = previousCookieSecure;
    }
  }
});

test("session cookies include Secure only when configured", () => {
  assert.match(buildSessionCookie("token", 60, { secure: true }), /; Secure$/);
  assert.doesNotMatch(buildSessionCookie("token", 60, { secure: false }), /; Secure/);
});

test("admin access requires an explicitly configured phone", () => {
  const user = { phone: "13800000000", accountType: "yimei" };
  assert.equal(isAdminUser(user, { admin: { phones: [] } }), false);
  assert.equal(isAdminUser(user, { admin: { phones: ["13800000000"] } }), true);
});

test("trend lookup only accepts normalized bucket items", () => {
  const brand = {
    trends: [
      { id: 1, title: "flat trend" },
      { key: "bucket", items: [{ id: 2, title: "bucketed trend", ideas: [] }] },
    ],
  };
  assert.equal(findTrendItem(brand, 1), null);
  assert.equal(findTrendItem(brand, 2)?.title, "bucketed trend");
});

test("single-slide xhs carousel generations are renderable in history", () => {
  assert.equal(
    isRenderableGeneration({
      type: "xhsCarousel",
      payload: {
        slides: [{ imageUrl: "https://image.example/one.png" }],
      },
    }),
    true,
  );
  assert.equal(
    isRenderableGeneration({
      type: "xhsCarousel",
      payload: {
        slides: [{ imageUrl: "https://image.example/one.png" }, { previewUrl: "" }],
      },
    }),
    false,
  );
});

test("route scope binding is cached by context object", () => {
  const context = { appConfig: { security: {} } };
  assert.equal(bindRouteScope(context), bindRouteScope(context));
  assert.notEqual(bindRouteScope(context), bindRouteScope({ appConfig: { security: {} } }));
});

test("signed asset URLs verify, reject tampering, and reject expiry", () => {
  const appConfig = { security: { assetSigningSecret: "test-secret" } };
  const signed = signAssetUrl(appConfig, "/api/generated-images/12/file?variant=preview", { ttlMs: 60_000 });
  assert.match(signed, /assetExpires=/);
  assert.match(signed, /assetSignature=/);
  assert.equal(verifySignedAssetRequest(appConfig, { url: signed, headers: { host: "localhost" } }), true);

  const tampered = signed.replace("/12/", "/13/");
  assert.equal(verifySignedAssetRequest(appConfig, { url: tampered, headers: { host: "localhost" } }), false);

  const expired = signAssetUrl(appConfig, "/api/product-images/7/file", { ttlMs: -1 });
  assert.equal(verifySignedAssetRequest(appConfig, { url: expired, headers: { host: "localhost" } }), false);
});

test("repository row mappers centralize snake case to camel case conversion", () => {
  const user = mapUserRow({
    id: 1,
    name: "Ada",
    phone: "13800000000",
    account_type: "customer",
    department: null,
    credits: 8,
    created_at: "2026-05-01T00:00:00.000Z",
  });
  assert.deepEqual(user, {
    id: 1,
    name: "Ada",
    phone: "13800000000",
    password: undefined,
    accountType: "customer",
    department: "",
    credits: 8,
    createdAt: "2026-05-01T00:00:00.000Z",
  });

  const brand = mapBrandRow({
    id: 3,
    owner_user_id: 1,
    name: "Redbase",
    industry: "retail",
    audience: "operators",
    description: "desc",
    product: "suite",
    goal: "growth",
    knowledge_base: "kb",
    logo_json: JSON.stringify({ storedPath: "uploads/logo.png" }),
    asset_tags_json: JSON.stringify(["a", "b"]),
  });
  assert.equal(brand.ownerUserId, 1);
  assert.equal(brand.logo.storedPath, "uploads/logo.png");
  assert.deepEqual(brand.assetTags, ["a", "b"]);

  const generation = mapGenerationRow({
    id: 4,
    owner_user_id: 1,
    type: "moments",
    channel_label: "朋友圈",
    brand_id: 3,
    brand_name: "Redbase",
    trend_id: 9,
    trend_title: "Trend",
    idea_title: "Idea",
    card_title: "Card",
    created_at: "2026-05-01T00:00:00.000Z",
    preview_url: "/api/generated-images/4/file",
    summary: "summary",
    payload_json: JSON.stringify({ title: "payload" }),
  });
  assert.equal(generation.ownerUserId, 1);
  assert.equal(generation.channelLabel, "朋友圈");
  assert.deepEqual(generation.payload, { title: "payload" });
});

test("snapshot auth helpers are no longer exposed through route scope", () => {
  const scope = bindRouteScope({ appConfig: { security: {} } });
  assert.equal(Object.hasOwn(helpers, "getAuthenticatedUser"), false);
  assert.equal(Object.hasOwn(helpers, "requireAuth"), false);
  assert.equal(Object.hasOwn(helpers, "requireAdmin"), false);
  assert.equal(Object.hasOwn(scope, "getAuthenticatedUser"), false);
  assert.equal(Object.hasOwn(scope, "requireAuth"), false);
  assert.equal(Object.hasOwn(scope, "requireAdmin"), false);
});

test("xhs carousel content accepts AI-generated brand-specific copy", () => {
  const pack = normalizeGeneratedXhsCarouselPack({
    title: "儿童用药新规小红书组图方案",
    publishTitle: "儿童用药新规发布，这些细节家长要看",
    publishCaption: "围绕儿童用药新规，把家长容易忽略的说明书、剂量边界和储药提醒讲清楚。小快克可以从安全科普角度进入，不做疗效承诺。",
    caption: "用四页组图讲清儿童用药新规、家庭场景、注意事项和收藏提醒。",
    slides: [1, 2, 3, 4].map((index) => ({
      pageLabel: `第 ${index} 张`,
      title: `儿童用药安全提醒 ${index}`,
      copy: `给儿童家长看的用药注意事项 ${index}`,
      visualDirection: `小快克儿童用药安全科普视觉 ${index}`,
      style: "专业、清晰、可信",
      composition: "竖版信息图，重点清楚，留白充足",
      prompt: `生成小红书第 ${index} 页，围绕儿童用药安全新规和小快克安全科普，避免疗效承诺。`,
    })),
  });
  const text = JSON.stringify(pack);
  assert.doesNotMatch(text, /特仑苏|牛奶|早餐|早晨|晨间|一杯|喝完|好牛奶/);
  assert.match(text, /小快克/);
  assert.match(text, /儿童用药/);
});

test("image concept metadata accepts AI-generated brand-specific copy", () => {
  const metadata = normalizeGeneratedImageConceptMetadata({
    title: "儿童用药安全朋友圈配图",
    caption: "儿童用药新规发布后，家长最需要先看懂说明书里的适用范围和注意事项。小快克从安全科普角度提醒，不替代医生建议。",
    visualDirection: "家庭药箱旁的儿童用药安全提醒卡片",
    style: "清晰、克制、可信",
    composition: "主体为药盒、说明书和家长查看提醒卡，画面干净",
    prompt: "生成朋友圈配图，围绕儿童用药安全新规和小快克安全科普，避免疗效承诺、剂量建议和诊断表达。",
  });

  assert.doesNotMatch(JSON.stringify(metadata), /特仑苏|牛奶|早餐|早晨|晨间|一杯|喝完|好牛奶/);
  assert.match(metadata.caption, /小快克|儿童用药|家长|安全/);
});

test("wechat long image content accepts AI-generated brand-specific copy", () => {
  const pack = normalizeGeneratedWechatLongImagePack({
    title: "儿童用药安全公众号长图方案",
    publishTitle: "儿童用药新规发布，家长先看懂这几处",
    intro: "儿童用药安全不是一句提醒，而是家长在看说明书、判断适用范围和保存药品时都需要理解的细节。",
    outline: [
      "新规里家长最容易忽略的说明书信息",
      "家庭场景下需要先确认的用药边界",
      "小快克适合以安全科普方式提供的提醒",
      "收藏前再核对医生建议和药品说明",
    ],
    positioning: "用于公众号文章开头，帮助家长建立儿童用药安全阅读框架。",
    cta: "收藏这张长图，下次查看儿童用药说明前先核对关键项。",
    visualDirection: "儿童用药安全科普长图，画面包含药品说明书、提醒卡和家庭药箱。",
    style: "专业、清晰、克制、可信",
    composition: "9:16 竖版长图，信息分层清楚，文字密度适中。",
    prompt: "生成公众号长图，围绕儿童用药安全新规和小快克安全科普，不做疗效承诺、剂量建议或诊断表达。",
  });

  assert.doesNotMatch(JSON.stringify(pack), /特仑苏|牛奶|早餐|早晨|晨间|一杯|喝完|好牛奶/);
  assert.match(pack.intro, /儿童用药|家长|安全/);
  assert.equal(pack.outline.length, 4);
});

test("image routes can consume content assets generated during trend analysis", () => {
  const contentAssets = {
    moments: {
      title: "儿童用药安全朋友圈配图",
      caption: "儿童用药新规发布后，家长最需要先看懂说明书里的适用范围和注意事项。",
      visualDirection: "家庭药箱旁的儿童用药安全提醒卡片",
      style: "清晰、克制、可信",
      composition: "主体为药盒、说明书和家长查看提醒卡，画面干净",
      prompt: "生成朋友圈配图：家庭药箱旁放着药品说明书和安全提醒卡，家长正在查看注意事项，画面清晰克制，不做疗效承诺。",
    },
    xhsCarousel: {
      title: "儿童用药安全小红书组图方案",
      publishTitle: "儿童用药新规发布，家长先看懂这几处",
      publishCaption: "把儿童用药安全里最容易忽略的说明书、适用范围和储药提醒讲清楚。",
      caption: "四页组图围绕儿童用药安全提醒展开。",
      slides: [1, 2, 3, 4].map((index) => ({
        pageLabel: `第 ${index} 张`,
        title: `儿童用药安全提醒 ${index}`,
        copy: `先核对说明书关键项 ${index}`,
        visualDirection: `儿童用药安全科普视觉 ${index}`,
        style: "专业、清晰、可信",
        composition: "竖版信息图，重点清楚，留白充足",
        prompt: `生成小红书组图第 ${index} 页：围绕儿童用药安全提醒做中文科普画面，突出说明书和家长核对动作。`,
      })),
    },
    wechatLongImage: {
      title: "儿童用药安全公众号长图方案",
      publishTitle: "儿童用药新规发布，家长先看懂这几处",
      intro: "儿童用药安全需要从说明书、适用范围和保存提醒开始看懂。",
      outline: ["看懂说明书", "确认适用范围", "注意家庭储药", "必要时咨询医生"],
      positioning: "用于公众号文章开头，帮助家长建立儿童用药安全阅读框架。",
      cta: "收藏这张长图，下次查看说明书前先核对。",
      visualDirection: "儿童用药安全科普长图",
      style: "专业、清晰、克制、可信",
      composition: "9:16 竖版长图，信息分层清楚，文字密度适中。",
      prompt: "生成公众号长图：用中文信息分层讲清儿童用药安全核对步骤，包含说明书、提醒卡和家庭药箱元素。",
    },
  };
  const idea = { title: "儿童用药新规发布，家长先看懂这几处", contentAssets };

  assert.match(buildImageConceptMetadataFromIdea(idea).prompt, /生成朋友圈配图/);
  assert.match(buildXhsCarouselPackFromIdea(idea).slides[0].prompt, /生成小红书组图第 1 页/);
  assert.match(buildWechatLongImagePackFromIdea(idea).prompt, /生成公众号长图/);
});
