const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSessionCookie } = require("../src/server/auth/cookies");
const { signAssetUrl, verifySignedAssetRequest } = require("../src/server/assets/signed-urls");
const { DEFAULT_APP_CONFIG, loadAppConfig } = require("../src/server/config");
const helpers = require("../src/server/api/helpers");
const { isAdminUser, findTrendItem } = helpers;
const { bindRouteScope } = require("../src/server/api/route-scope");
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
