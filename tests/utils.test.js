const test = require("node:test");
const assert = require("node:assert/strict");

const { parseJsonFromModelText } = require("../src/server/utils");

test("repairs unescaped quotes in a model JSON response without another model call", () => {
  const result = parseJsonFromModelText(`{
    "trendBuckets": [{
      "key": "traffic",
      "items": [{
        "title": "孩子要学会说"不"",
        "score": 90
      }]
    }]
  }`);

  assert.equal(result.trendBuckets[0].items[0].title, '孩子要学会说"不"');
  assert.equal(result.trendBuckets[0].items[0].score, 90);
});

test("repairs truncated model JSON by closing containers", () => {
  const result = parseJsonFromModelText('{"trendBuckets":[{"key":"traffic","items":[{"title":"趋势 A","score":88}]}');

  assert.equal(result.trendBuckets[0].items[0].title, "趋势 A");
});
