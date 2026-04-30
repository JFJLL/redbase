const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSessionCookie } = require("../src/server/auth/cookies");
const { DEFAULT_APP_CONFIG, loadAppConfig } = require("../src/server/config");
const { isAdminUser, findTrendItem } = require("../src/server/api/helpers");
const { bindRouteScope } = require("../src/server/api/route-scope");

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
