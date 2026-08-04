const test = require("node:test");
const assert = require("node:assert/strict");

const { parseSendSmsResponse } = require("../src/server/integrations/sms");

test("real Aliyun success body uses lowercase code and is accepted", () => {
  const parsed = parseSendSmsResponse({ body: { code: "OK", message: "OK", requestId: "req-1" } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, "OK");
});

test("real Aliyun business failure uses lowercase code and is rejected", () => {
  const parsed = parseSendSmsResponse({
    body: { code: "isv.BUSINESS_LIMIT_CONTROL", message: "触发分钟级流控" },
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "isv.BUSINESS_LIMIT_CONTROL");
});

test("uppercase Code is not treated as a real success", () => {
  const parsed = parseSendSmsResponse({ body: { Code: "OK" } });
  assert.equal(parsed.ok, false);
});

test("missing response body is rejected", () => {
  assert.equal(parseSendSmsResponse(null).ok, false);
});
