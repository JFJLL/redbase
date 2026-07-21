const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SUPPORTED_ASPECT_RATIOS,
  getDefaultAspectRatio,
  isSupportedAspectRatio,
  resolveAspectRatio,
} = require("../src/server/api/aspect-ratios");

test("supports every aspect ratio exposed by the image generation UI", () => {
  assert.deepEqual(SUPPORTED_ASPECT_RATIOS, [
    "1:1",
    "1:2",
    "2:1",
    "1:3",
    "3:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "21:9",
    "9:21",
    "16:9",
  ]);
  for (const ratio of SUPPORTED_ASPECT_RATIOS) {
    assert.equal(isSupportedAspectRatio(ratio), true, ratio);
  }
  assert.equal(isSupportedAspectRatio("4:7"), false);
});

test("smart aspect ratio keeps current defaults except WeChat long images", () => {
  assert.equal(getDefaultAspectRatio("moments"), "3:4");
  assert.equal(getDefaultAspectRatio("wechat"), "9:21");
  assert.equal(getDefaultAspectRatio("xhsCarousel"), "3:4");
  assert.equal(getDefaultAspectRatio("xhsCarouselSlide"), "3:4");
  assert.equal(getDefaultAspectRatio("styleImage"), "3:4");
});

test("resolves smart and explicit ratios while rejecting unknown values", () => {
  assert.equal(resolveAspectRatio("smart", "wechat"), "9:21");
  assert.equal(resolveAspectRatio("", "moments"), "3:4");
  assert.equal(resolveAspectRatio(" 16:9 ", "wechat"), "16:9");
  assert.equal(resolveAspectRatio("4:7", "moments"), null);
});
