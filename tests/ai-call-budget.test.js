const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  DEFAULT_BUDGETS,
  createAiCallBudget,
  buildBudgetExceededPartial,
  isAiCallBudgetExceededError,
  BUDGET_EXCEEDED_REASON,
} = require("../src/server/ai/ai-call-budget");
const { callTextModelJson } = require("../src/server/ai/text-provider");
const { generateAiTrendSet } = require("../src/server/ai/trend-service");
const { extractMarketSignals } = require("../src/server/ai/trend-signal-extractor");

test("createAiCallBudget uses default maxCalls by task", () => {
  const budget = createAiCallBudget({ task: "trend_analysis" });
  assert.equal(budget.maxCalls, DEFAULT_BUDGETS.trend_analysis);
  assert.equal(budget.remaining(), 5);
  assert.equal(budget.exhausted(), false);

  const first = budget.consume();
  assert.equal(first.calls_used, 1);
  assert.equal(first.calls_remaining, 4);
  assert.equal(first.task, "trend_analysis");
});

test("consume throws partial budget exceeded after maxCalls", () => {
  const budget = createAiCallBudget({ task: "trend_analysis", maxCalls: 2 });
  budget.consume();
  budget.consume();
  assert.equal(budget.exhausted(), true);
  assert.throws(
    () => budget.consume(),
    (error) => {
      assert.equal(error.partial, true);
      assert.equal(error.reason, BUDGET_EXCEEDED_REASON);
      assert.equal(error.retryable, false);
      assert.ok(isAiCallBudgetExceededError(error));
      assert.deepEqual(buildBudgetExceededPartial(budget), {
        partial: true,
        reason: BUDGET_EXCEEDED_REASON,
        task: "trend_analysis",
        calls_used: 2,
        calls_remaining: 0,
      });
      return true;
    },
  );
});

test("callTextModelJson stops transport retries when budget is exhausted", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const budget = createAiCallBudget({ task: "trend_analysis", maxCalls: 2 });

  await assert.rejects(
    callTextModelJson({
      textProvider: {
        apiStyle: "openai",
        model: "fixture-model",
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture-key",
      },
    }, {
      systemPrompt: "Return JSON",
      userPrompt: "ping",
      maxAttempts: 5,
      delayMs: 1,
      budget,
    }),
  );

  // Budget caps physical HTTP attempts exactly: maxCalls=2 with maxAttempts=5 → 2 calls.
  assert.equal(requestCount, 2, `expected exactly 2 transport calls, got ${requestCount}`);
  assert.equal(budget.snapshot().calls_used, 2);
  assert.equal(budget.remaining(), 0);
  assert.equal(budget.exhausted(), true);
});

test("callTextModelJson with maxCalls=1 performs exactly one HTTP attempt", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const budget = createAiCallBudget({ task: "trend_analysis", maxCalls: 1 });

  await assert.rejects(
    callTextModelJson({
      textProvider: {
        apiStyle: "openai",
        model: "fixture-model",
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture-key",
      },
    }, {
      systemPrompt: "Return JSON",
      userPrompt: "ping",
      maxAttempts: 5,
      delayMs: 1,
      budget,
    }),
  );

  assert.equal(requestCount, 1);
  assert.equal(budget.snapshot().calls_used, 1);
  assert.equal(budget.exhausted(), true);
});

test("generateAiTrendSet does not infinite-retry past AI call budget", async () => {
  let modelCalls = 0;
  await assert.rejects(
    generateAiTrendSet({
      searchProvider: {
        enabled: true,
        socialEnabled: true,
        minReliableEvidence: 1,
        urlCheckEnabled: false,
        cacheTtlMs: 0,
      },
      textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
    }, {
      id: 1,
      name: "BudgetBrand",
      industry: "家居",
      audience: "租房人群",
      product: "折叠灯",
      description: "小空间照明",
      goal: "内容增长",
    }, 9900, {
      bucketKey: "traffic",
      maxAiCalls: 2,
      anySearchEvidence: {
        queries: ["桌面照明"],
        evidence: [{
          id: "S1",
          title: "租房桌面从固定台灯转向折叠便携照明",
          snippet: "用户吐槽桌面拥挤，需要可收纳补光。",
          sourceType: "web",
          trustLevel: "medium",
          publishedAt: "2026-07-16",
          url: "https://example.com/desk-light",
        }],
        reliableCount: 1,
        retrievedAt: new Date("2026-07-16T12:00:00.000Z"),
        cacheHit: false,
      },
      textModelImpl: async () => {
        modelCalls += 1;
        // Always invalid so generation would retry without a budget cap.
        return { trendBuckets: [{ key: "traffic", items: [] }] };
      },
    }),
    (error) => {
      assert.equal(error.partial, true);
      assert.equal(error.reason, BUDGET_EXCEEDED_REASON);
      assert.ok(isAiCallBudgetExceededError(error));
      assert.match(String(error.message || ""), /未保存|未扣积分|budget exceeded/i);
      return true;
    },
  );

  assert.equal(modelCalls, 2, `expected exactly 2 model calls under budget, got ${modelCalls}`);
});

test("extractMarketSignals returns partial marker when shared budget is exhausted", () => {
  const budget = createAiCallBudget({ task: "trend_analysis", maxCalls: 1 });
  budget.consume();
  const result = extractMarketSignals({
    brand: { name: "BudgetBrand" },
    evidence: [{ id: "S1", title: "话题", snippet: "用户需要补光", sourceType: "web" }],
    budget,
  });
  assert.equal(result.partial, true);
  assert.equal(result.reason, BUDGET_EXCEEDED_REASON);
  assert.deepEqual(result.signals, []);
});
