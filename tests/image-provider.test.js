const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildImageProviderRequest,
  buildKeystoneEditFormData,
  parseImageProviderSubmission,
  parseImageProviderResult,
  validateImageProviderSubmission,
} = require("../src/server/ai/image-jobs");
const { DEFAULT_APP_CONFIG, loadAppConfig } = require("../src/server/config");

const keystone = {
  provider: "keystone",
  model: "gpt-image-2",
  resolution: "auto",
  quality: "medium",
  imageCount: 1,
};

test("image provider configuration defaults to Keystone OpenAI-compatible endpoints", () => {
  assert.equal(DEFAULT_APP_CONFIG.imageProvider.provider, "keystone");
  assert.equal(DEFAULT_APP_CONFIG.imageProvider.baseUrl, "https://keystonehk.ai/v1/images/generations");
  assert.equal(DEFAULT_APP_CONFIG.imageProvider.editBaseUrl, "https://keystonehk.ai/v1/images/edits");
  assert.equal(DEFAULT_APP_CONFIG.imageProvider.queryBaseUrl, "");
  assert.equal(DEFAULT_APP_CONFIG.imageProvider.model, "gpt-image-2");
});

test("legacy image provider configuration is normalized to Keystone", () => {
  const names = [
    "IMAGE_PROVIDER",
    "IMAGE_BASE_URL",
    "IMAGE_EDIT_BASE_URL",
    "IMAGE_UPLOAD_BASE_URL",
    "IMAGE_QUERY_BASE_URL",
    "IMAGE_MODEL",
    "IMAGE_RESOLUTION",
    "IMAGE_QUALITY",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.IMAGE_PROVIDER = "runninghub";
    process.env.IMAGE_BASE_URL = "https://api.runninghub.ai/openapi/v2/generate";
    process.env.IMAGE_EDIT_BASE_URL = "https://api.runninghub.ai/openapi/v2/edit";
    process.env.IMAGE_UPLOAD_BASE_URL = "https://api.runninghub.ai/openapi/v2/upload";
    process.env.IMAGE_QUERY_BASE_URL = "https://api.runninghub.ai/openapi/v2/query";
    delete process.env.IMAGE_MODEL;
    delete process.env.IMAGE_RESOLUTION;
    delete process.env.IMAGE_QUALITY;

    const config = loadAppConfig();
    assert.equal(config.imageProvider.provider, "keystone");
    assert.equal(config.imageProvider.baseUrl, "https://keystonehk.ai/v1/images/generations");
    assert.equal(config.imageProvider.editBaseUrl, "https://keystonehk.ai/v1/images/edits");
    assert.equal(config.imageProvider.uploadBaseUrl, "");
    assert.equal(config.imageProvider.queryBaseUrl, "");
    assert.equal(config.imageProvider.model, "gpt-image-2");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("Keystone generation requests use OpenAI image fields and map the app aspect ratio", () => {
  assert.deepEqual(
    buildImageProviderRequest(keystone, {
      prompt: "Create a poster",
      aspectRatio: "3:4",
    }),
    {
      model: "gpt-image-2",
      prompt: "Create a poster",
      size: "1024x1536",
      quality: "medium",
      n: 1,
    },
  );
  assert.equal("aspect_ratio" in buildImageProviderRequest(keystone, { prompt: "x", aspectRatio: "3:4" }), false);
  assert.deepEqual(
    buildImageProviderRequest({ ...keystone, resolution: "1:1" }, { prompt: "Square", aspectRatio: "1:1" }),
    {
      model: "gpt-image-2",
      prompt: "Square",
      size: "1024x1024",
      quality: "medium",
      n: 1,
    },
  );
  assert.equal(
    buildImageProviderRequest({ ...keystone, resolution: "16:9" }, { prompt: "Landscape", aspectRatio: "16:9" }).size,
    "1536x1024",
  );
});

test("Keystone image edit form uses image for one reference and image[] for multiple references", () => {
  const single = buildKeystoneEditFormData(keystone, {
    prompt: "Edit the poster",
    aspectRatio: "3:4",
    references: [{ buffer: Buffer.from("png"), mimeType: "image/png", fileName: "product.png" }],
  });
  assert.equal(single.get("model"), "gpt-image-2");
  assert.equal(single.get("size"), "1024x1536");
  assert.equal(single.get("n"), "1");
  assert.equal(single.get("image").name, "product.png");
  assert.equal(single.getAll("image[]").length, 0);

  const multiple = buildKeystoneEditFormData(keystone, {
    prompt: "Combine the references",
    aspectRatio: "1:1",
    references: [
      { buffer: Buffer.from("png"), mimeType: "image/png", fileName: "one.png" },
      { buffer: Buffer.from("jpg"), mimeType: "image/jpeg", fileName: "two.jpg" },
    ],
  });
  assert.equal(multiple.get("image"), null);
  assert.equal(multiple.getAll("image[]").length, 2);
});

test("Keystone submissions support URL and b64_json image outputs", () => {
  assert.deepEqual(
    parseImageProviderSubmission(keystone, {
      created: 1,
      data: [{ url: "https://example.com/output.png" }],
    }),
    {
      taskId: "",
      resultUrl: "",
      imageUrl: "https://example.com/output.png",
      status: "completed",
      error: "",
    },
  );
  assert.equal(
    parseImageProviderResult(keystone, { data: [{ b64_json: "cG5n" }] }).imageUrl,
    "data:image/png;base64,cG5n",
  );
  assert.deepEqual(
    parseImageProviderResult(keystone, { error: { code: "invalid", message: "invalid prompt" } }),
    {
      imageUrl: "",
      status: "failed",
      error: "invalid prompt",
    },
  );
});

test("Keystone validation rejects missing synchronous image data", () => {
  assert.doesNotThrow(() =>
    validateImageProviderSubmission(keystone, {
      taskId: "",
      resultUrl: "",
      imageUrl: "data:image/png;base64,cG5n",
      status: "completed",
      error: "",
    }),
  );
  assert.throws(
    () => validateImageProviderSubmission(keystone, { taskId: "", resultUrl: "", imageUrl: "", status: "pending", error: "" }),
    /Keystone 图片服务未返回图片数据/,
  );
  assert.throws(
    () => validateImageProviderSubmission(keystone, { taskId: "", resultUrl: "", imageUrl: "", status: "failed", error: "invalid prompt" }),
    /invalid prompt/,
  );
});

test("WaveSpeed request and response contracts remain compatible", () => {
  const wavespeed = { provider: "wavespeed", resolution: "1k", quality: "medium" };
  assert.deepEqual(
    buildImageProviderRequest(wavespeed, {
      prompt: "Create a poster",
      aspectRatio: "3:4",
      imageUrls: ["https://example.com/logo.png"],
    }),
    {
      prompt: "Create a poster",
      aspect_ratio: "3:4",
      resolution: "1k",
      quality: "medium",
      enable_sync_mode: false,
      enable_base64_output: false,
      images: ["https://example.com/logo.png"],
    },
  );
  assert.deepEqual(
    parseImageProviderResult(wavespeed, {
      data: { status: "completed", outputs: ["https://example.com/output.png"] },
    }),
    {
      imageUrl: "https://example.com/output.png",
      status: "completed",
      error: "",
    },
  );
});
