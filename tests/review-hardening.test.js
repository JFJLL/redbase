const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const { buildSessionCookie } = require("../src/server/auth/cookies");
const { signAssetUrl, signLocalAssetUrls, verifySignedAssetRequest } = require("../src/server/assets/signed-urls");
const { buildImageJobResponse } = require("../src/server/ai/image-jobs");
const { DEFAULT_APP_CONFIG, loadAppConfig } = require("../src/server/config");
const { applyCorsHeaders, validateCorsConfigForStartup } = require("../src/server/cors");
const { handleHealthRoutes } = require("../src/server/api/health-routes");
const { getTrendAnalysisPublicErrorMessage } = require("../src/server/api/trend-routes");
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

test("text provider defaults use the selected OpenAI-compatible DeepSeek endpoint", () => {
  assert.equal(DEFAULT_APP_CONFIG.textProvider.apiStyle, "openai");
  assert.equal(DEFAULT_APP_CONFIG.textProvider.model, "deepseek/deepseek-v4-flash");
  assert.equal(DEFAULT_APP_CONFIG.textProvider.openaiBaseUrl, "https://llm.runninghub.ai/v1");
  assert.equal(DEFAULT_APP_CONFIG.textProvider.anthropicBaseUrl, "");
});

test("trend routes preserve actionable AnySearch and model validation errors", () => {
  assert.equal(getTrendAnalysisPublicErrorMessage({
    code: "ANYSEARCH_NETWORK_ERROR",
    message: "AnySearch 网络连接失败。",
  }), "热点搜索服务暂时无法连接，请稍后重试。本次结果未保存，也不会扣积分。");
  assert.doesNotMatch(getTrendAnalysisPublicErrorMessage({
    code: "ANYSEARCH_NETWORK_ERROR",
    message: "AnySearch 网络连接失败。",
  }), /AnySearch|网络连接失败/);
  assert.match(getTrendAnalysisPublicErrorMessage({
    code: "TREND_MODEL_VALIDATION_FAILED",
    message: "模型连续 3 次未返回完整趋势。",
  }), /模型连续 3 次/);
  assert.match(getTrendAnalysisPublicErrorMessage({ code: "PGY_TIMEOUT" }), /小红书热点数据/);
  const internalMessage = getTrendAnalysisPublicErrorMessage({
    code: "SQLITE_CONSTRAINT",
    message: "UNIQUE constraint failed: trend_analysis_requests.request_id",
  });
  assert.equal(internalMessage, "本次分析未能获取到可用热点，请稍后重试。");
  assert.doesNotMatch(internalMessage, /SQLITE|constraint|trend_analysis_requests/i);
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
    true,
  );
  assert.equal(
    isRenderableGeneration({
      type: "xhsCarousel",
      payload: {
        slides: [{ imageUrl: "" }, { previewUrl: "" }],
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

test("signed asset URLs are stable within the same cache window", () => {
  const appConfig = { security: { assetSigningSecret: "test-secret" } };
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const first = signAssetUrl(appConfig, "/api/generated-images/12/file", { ttlMs: 60_000, nowMs: windowStart + 1_000 });
  const second = signAssetUrl(appConfig, "/api/generated-images/12/file", { ttlMs: 60_000, nowMs: windowStart + 59_000 });
  const nextWindow = signAssetUrl(appConfig, "/api/generated-images/12/file", { ttlMs: 60_000, nowMs: windowStart + 61_000 });

  assert.equal(first, second);
  assert.notEqual(first, nextWindow);
  assert.equal(verifySignedAssetRequest(appConfig, { url: first, headers: { host: "localhost" } }), true);
});

test("completed image job responses sign local generated image URLs", () => {
  const appConfig = { security: { assetSigningSecret: "test-secret" } };
  const response = signLocalAssetUrls(
    buildImageJobResponse({
      id: "job-1",
      status: "completed",
      createdAt: Date.now(),
      provider: "wavespeed",
      model: "gpt-image-2",
      metadata: { title: "Generated image" },
      imageUrl: "/api/generated-images/42/file",
      error: "",
    }),
    appConfig,
  );

  assert.match(response.imageConcept.imageUrl, /assetExpires=/);
  assert.match(response.imageConcept.previewUrl, /assetSignature=/);
  assert.equal(verifySignedAssetRequest(appConfig, { url: response.imageConcept.imageUrl, headers: { host: "localhost" } }), true);
});

test("completed image job responses do not expose prompt or provider internals", () => {
  const response = buildImageJobResponse({
    id: "job-2",
    status: "completed",
    createdAt: Date.now(),
    provider: "wavespeed",
    model: "gpt-image-2",
    metadata: {
      title: "Generated image",
      prompt: "full private prompt",
      editPrompt: "private edit prompt",
      stylePrompt: "private style prompt",
      visualDirection: "clean visual",
    },
    imageUrl: "/api/generated-images/42/file",
    error: "",
  });

  const text = JSON.stringify(response);
  assert.equal(response.imageConcept.title, "Generated image");
  assert.equal(response.imageConcept.visualDirection, "clean visual");
  assert.doesNotMatch(text, /full private prompt|private edit prompt|private style prompt|wavespeed|gpt-image-2/);
});

test("sanitizeGeneration removes prompt and provider internals recursively", () => {
  const sanitized = helpers.sanitizeGeneration({
    id: 1,
    ownerUserId: 1,
    type: "xhsCarousel",
    channelLabel: "小红书组图",
    brandId: 1,
    brandName: "Brand",
    trendId: 1,
    trendTitle: "Trend",
    ideaTitle: "Idea",
    cardTitle: "Card",
    createdAt: "2026-05-02T00:00:00.000Z",
    previewUrl: "",
    summary: "",
    payload: {
      prompt: "private prompt",
      provider: "wavespeed",
      slides: [{ title: "slide", model: "gpt-image-2", prompt: "slide prompt" }],
    },
  });

  const text = JSON.stringify(sanitized);
  assert.doesNotMatch(text, /private prompt|slide prompt|wavespeed|gpt-image-2/);
  assert.equal(sanitized.payload.slides[0].title, "slide");
});

test("CORS rejects credentialed wildcard and allows noncredentialed wildcard only", () => {
  assert.throws(
    () => validateCorsConfigForStartup({ cors: { origins: ["*"], credentials: true } }, "production"),
    /wildcard origin/,
  );
  assert.doesNotThrow(() => validateCorsConfigForStartup({ cors: { origins: [], credentials: true } }, "production"));

  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
  };
  const applied = applyCorsHeaders(
    { headers: { origin: "https://evil.example" } },
    res,
    { cors: { origins: ["*"], credentials: false } },
  );
  assert.equal(applied, true);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(Object.hasOwn(res.headers, "Access-Control-Allow-Credentials"), false);
});

test("public health response does not expose provider configuration", async () => {
  const res = {
    statusCode: 0,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(data) {
      this.body = JSON.parse(data);
    },
  };
  const handled = await handleHealthRoutes(
    { appConfig: DEFAULT_APP_CONFIG },
    { method: "GET", headers: {} },
    res,
    "/api/health",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /textProvider|imageProvider|model|baseUrl|searchEnabled|configured/);
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

// 迁移说明：以下两个用例原断言 public/app.js 与 public/js/state.js，已随旧前端
// 删除，改为断言新实现（同强度）：
//   frontend/src/features/trends/views/TrendsView.vue   （bindAnalysisButton → handleRunAnalysis/attemptAnalysis/finishAnalysis）
//   frontend/src/features/trends/stores/insights.ts     （state.js trendAnalysisLoadingKeys + setTrendAnalysisBusy → setAnalysisBusy）
//   frontend/src/features/trends/model/trendBuckets.ts  （sortTrendItemsForDisplay / getTrendBucketsForBrand / mergeGeneratedTrendResult / formatTrendAnalysisError）
test("trend analysis loading state is scoped by brand and bucket", () => {
  const viewSource = readFileSync(
    path.join(__dirname, "../frontend/src/features/trends/views/TrendsView.vue"),
    "utf8",
  );
  const storeSource = readFileSync(
    path.join(__dirname, "../frontend/src/features/trends/stores/insights.ts"),
    "utf8",
  );
  const modelSource = readFileSync(
    path.join(__dirname, "../frontend/src/features/trends/model/trendBuckets.ts"),
    "utf8",
  );
  const analysisHandler = viewSource.slice(
    viewSource.indexOf("async function handleRunAnalysis"),
    viewSource.indexOf("function schedulePoll"),
  );

  assert.match(storeSource, /trendAnalysisLoadingKeys:\s*\[\] as string\[\]/);
  assert.match(analysisHandler, /store\.setAnalysisBusy\(brandId, key, true\)/);
  // finishAnalysis 是旧 setTrendAnalysisBusy(brandId, bucketKey, false) 的作用域化等价物
  assert.match(analysisHandler, /finishAnalysis\(brandId, key\);/);
  assert.match(
    viewSource,
    /function finishAnalysis\(brandId: number, key: string\)[\s\S]*?setAnalysisBusy\(brandId, key, false\)/,
  );
  assert.ok(
    analysisHandler.indexOf("store.setAnalysisBusy(brandId, key, true)")
      < analysisHandler.indexOf("await store.ensureBrandDetail(brandId"),
    "loading guard must be set before awaiting brand details to prevent duplicate analysis requests",
  );
  // 分析流程不得触发全局 busy（旧 setBusy(true) 的等价禁止）
  assert.doesNotMatch(analysisHandler, /setBusy\(true\)|pageBusy\.value\s*=\s*true/);
  assert.match(analysisHandler, /requestId/);
  assert.match(analysisHandler, /generatedBucket\.items\?\.length !== 10/);
  assert.match(storeSource, /mergeGeneratedTrendResult\(previous, result\.brand, bucketKey\)/);
  assert.doesNotMatch(analysisHandler, /showTrendAnalysisWarnings/);
  assert.match(viewSource, /store\.isAnalysisLoading\(brand\.value\.id, bucketKey\.value\)/);
  assert.match(modelSource, /previousBucket\?\.items\?\.length \? previousBucket : incomingBucket/);
  assert.match(modelSource, /message\.includes\("热点搜索服务"\)/);
});

test("trend display sorts every loaded bucket by score and refreshes visible ranks", () => {
  const modelSource = readFileSync(
    path.join(__dirname, "../frontend/src/features/trends/model/trendBuckets.ts"),
    "utf8",
  );
  const sortHelper = modelSource.slice(
    modelSource.indexOf("export function sortTrendItemsForDisplay"),
    modelSource.indexOf("export function getTrendBucketsForBrand"),
  );
  const bucketHelper = modelSource.slice(
    modelSource.indexOf("export function getTrendBucketsForBrand"),
    modelSource.indexOf("export function firstTrendBucket"),
  );

  assert.match(sortHelper, /right\.score - left\.score/);
  assert.match(sortHelper, /rank:\s*index \+ 1/);
  assert.match(bucketHelper, /items:\s*sortTrendItemsForDisplay\(bucket\.items\)/);
});

test("wechat long image content repairs a short model outline from the same generated pack", () => {
  const pack = normalizeGeneratedWechatLongImagePack({
    title: "小空间照明长图方案",
    publishTitle: "桌面不够大，灯光也能更灵活",
    intro: "租房与居家办公场景里，桌面空间有限，照明需要兼顾收纳、移动和实际使用体验。",
    outline: ["先判断桌面真正需要照亮的区域", "再比较折叠收纳与移动使用场景"],
    positioning: "帮助小空间用户建立桌面照明选择框架。",
    cta: "保存这份清单，布置桌面前逐项核对。",
    visualDirection: "小空间桌面与折叠灯的使用场景对比。",
  });

  assert.equal(pack.outline.length, 3);
  assert.deepEqual(pack.outline.slice(0, 2), ["先判断桌面真正需要照亮的区域", "再比较折叠收纳与移动使用场景"]);
  assert.match(pack.outline[2], /选择框架|逐项核对/);
});

test("xhs carousel reuses the generated publish caption when the redundant pack caption is omitted", () => {
  const publishCaption = "小桌面也能有清楚的工作光线，从照明区域、折叠收纳和移动使用三个角度逐项检查。";
  const pack = normalizeGeneratedXhsCarouselPack({
    title: "小空间照明组图",
    publishTitle: "桌面不够大，灯光怎么选",
    publishCaption,
    slides: [1, 2, 3, 4].map((index) => ({
      pageLabel: `第 ${index} 张`,
      title: `检查项 ${index}`,
      copy: `第 ${index} 个小空间照明检查项，说明实际使用时需要关注的条件。`,
      visualDirection: `小桌面照明检查场景 ${index}`,
    })),
  });

  assert.equal(pack.caption, publishCaption);
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
