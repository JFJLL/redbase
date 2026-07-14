const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildImageProviderRequest,
  parseImageProviderSubmission,
  parseImageProviderResult,
  validateImageProviderSubmission,
} = require("../src/server/ai/image-jobs");
const { DEFAULT_APP_CONFIG } = require("../src/server/config");

const runningHub = {
  provider: "runninghub",
  queryBaseUrl: "https://www.runninghub.ai/openapi/v2/query",
  resolution: "1k",
  quality: "medium",
};

test("image provider configuration declares provider and query endpoint", () => {
  assert.equal(DEFAULT_APP_CONFIG.imageProvider.provider, "wavespeed");
  assert.equal(DEFAULT_APP_CONFIG.imageProvider.queryBaseUrl, "");
});

test("RunningHub image requests use camelCase fields and imageUrls", () => {
  const body = buildImageProviderRequest(runningHub, {
    prompt: "Create a poster",
    aspectRatio: "3:4",
    imageUrls: ["https://example.com/logo.png"],
  });

  assert.deepEqual(body, {
    prompt: "Create a poster",
    imageUrls: ["https://example.com/logo.png"],
    aspectRatio: "3:4",
    resolution: "1k",
    quality: "medium",
  });
  assert.equal("aspect_ratio" in body, false);
  assert.equal("images" in body, false);
});

test("RunningHub capability flags omit unsupported text and quality fields", () => {
  const provider = {
    ...runningHub,
    sendTextResolution: false,
    sendQuality: false,
  };

  assert.deepEqual(
    buildImageProviderRequest(provider, {
      prompt: "Create a poster",
      aspectRatio: "3:4",
      imageUrls: [],
    }),
    {
      prompt: "Create a poster",
      aspectRatio: "3:4",
    },
  );

  assert.deepEqual(
    buildImageProviderRequest(provider, {
      prompt: "Edit a poster",
      aspectRatio: "3:4",
      imageUrls: ["https://example.com/logo.png"],
    }),
    {
      prompt: "Edit a poster",
      imageUrls: ["https://example.com/logo.png"],
      aspectRatio: "3:4",
      resolution: "1k",
    },
  );
});

test("RunningHub submissions retain task id and query endpoint", () => {
  const result = parseImageProviderSubmission(runningHub, {
    taskId: "task-123",
    status: "QUEUED",
    results: null,
  });

  assert.deepEqual(result, {
    taskId: "task-123",
    resultUrl: runningHub.queryBaseUrl,
    imageUrl: "",
    status: "pending",
    error: "",
  });
});

test("provider submission validation preserves upstream errors and provider compatibility", () => {
  assert.throws(
    () =>
      validateImageProviderSubmission(runningHub, {
        taskId: "",
        resultUrl: runningHub.queryBaseUrl,
        imageUrl: "",
        status: "failed",
        error: "invalid prompt",
      }),
    /invalid prompt/,
  );

  assert.doesNotThrow(() =>
    validateImageProviderSubmission(
      { provider: "wavespeed" },
      {
        taskId: "",
        resultUrl: "https://api.example.com/results/job-1",
        imageUrl: "",
        status: "pending",
        error: "",
      },
    ),
  );

  assert.throws(
    () =>
      validateImageProviderSubmission(runningHub, {
        taskId: "",
        resultUrl: runningHub.queryBaseUrl,
        imageUrl: "",
        status: "pending",
        error: "",
      }),
    /未返回可轮询的任务地址/,
  );
});

test("RunningHub result parsing handles success and failure", () => {
  assert.deepEqual(
    parseImageProviderResult(runningHub, {
      taskId: "task-123",
      status: "SUCCESS",
      results: [{ url: "https://example.com/output.png" }],
    }),
    {
      imageUrl: "https://example.com/output.png",
      status: "completed",
      error: "",
    },
  );

  assert.deepEqual(
    parseImageProviderResult(runningHub, {
      taskId: "task-123",
      status: "FAILED",
      errorCode: "E_MODEL",
      errorMessage: "generation failed",
    }),
    {
      imageUrl: "",
      status: "failed",
      error: "generation failed",
    },
  );

  assert.deepEqual(
    parseImageProviderResult(runningHub, {
      taskId: "task-123",
      status: "FAILED",
      errorCode: "E_MODEL",
      errorMessage: "",
    }),
    {
      imageUrl: "",
      status: "failed",
      error: "E_MODEL",
    },
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
