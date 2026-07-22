/**
 * Unified AI call budget manager.
 *
 * Caps physical model invocations across transport retry, generation retry,
 * and repair retry so a single trend-analysis request cannot explode into
 * unbounded model traffic.
 */

const DEFAULT_BUDGETS = {
  trend_analysis: 5,
  signal_extraction: 2,
  brand_intelligence: 1,
  image_generation: 3,
};

const BUDGET_EXCEEDED_REASON = "AI call budget exceeded";

function resolveMaxCalls(task, maxCalls) {
  if (Number.isFinite(Number(maxCalls))) {
    return Math.max(0, Math.floor(Number(maxCalls)));
  }
  const defaultForTask = DEFAULT_BUDGETS[task];
  if (Number.isFinite(Number(defaultForTask))) {
    return Math.max(0, Math.floor(Number(defaultForTask)));
  }
  return DEFAULT_BUDGETS.trend_analysis;
}

function createBudgetExceededError(task, callsUsed, maxCalls) {
  // Public message keeps the no-charge assurance used by other TREND_ failures.
  // Contract fields partial/reason stay machine-readable in English.
  const error = new Error("模型调用次数已达上限，本次结果未保存，也不会扣积分。");
  // TREND_ prefix so trend-routes surfaces the message and fails without saving.
  error.code = "TREND_AI_CALL_BUDGET_EXCEEDED";
  error.retryable = false;
  error.partial = true;
  error.reason = BUDGET_EXCEEDED_REASON;
  error.task = task;
  error.calls_used = callsUsed;
  error.calls_remaining = 0;
  error.maxCalls = maxCalls;
  return error;
}

/**
 * @param {{ task?: string, maxCalls?: number }} input
 * @returns {{
 *   task: string,
 *   maxCalls: number,
 *   consume: () => { task: string, calls_used: number, calls_remaining: number },
 *   remaining: () => number,
 *   exhausted: () => boolean,
 *   snapshot: () => { task: string, calls_used: number, calls_remaining: number, maxCalls: number },
 * }}
 */
function createAiCallBudget(input = {}) {
  const task = String(input?.task || "unknown").trim() || "unknown";
  const maxCalls = resolveMaxCalls(task, input?.maxCalls);
  let callsUsed = 0;

  function remaining() {
    return Math.max(0, maxCalls - callsUsed);
  }

  function exhausted() {
    return remaining() <= 0;
  }

  function snapshot() {
    return {
      task,
      calls_used: callsUsed,
      calls_remaining: remaining(),
      maxCalls,
    };
  }

  function logUsage() {
    console.log("[ai-call-budget]", {
      task,
      calls_used: callsUsed,
      calls_remaining: remaining(),
    });
  }

  /**
   * Reserve one physical model call.
   * Throws a non-retryable partial error when the budget is already exhausted.
   */
  function consume() {
    if (exhausted()) {
      throw createBudgetExceededError(task, callsUsed, maxCalls);
    }
    callsUsed += 1;
    logUsage();
    return {
      task,
      calls_used: callsUsed,
      calls_remaining: remaining(),
    };
  }

  return {
    task,
    maxCalls,
    consume,
    remaining,
    exhausted,
    snapshot,
  };
}

function isAiCallBudgetExceededError(error) {
  const code = String(error?.code || "");
  return Boolean(
    error
    && (
      code === "AI_CALL_BUDGET_EXCEEDED"
      || code === "TREND_AI_CALL_BUDGET_EXCEEDED"
      || error.reason === BUDGET_EXCEEDED_REASON
      || (error.partial === true && /budget exceeded/i.test(String(error.message || "")))
    ),
  );
}

/**
 * Structured partial marker used by callers/tests when budget stops retries.
 * Shape: { partial: true, reason: "AI call budget exceeded", ... }
 */
function buildBudgetExceededPartial(budgetOrError = null) {
  if (budgetOrError && typeof budgetOrError.snapshot === "function") {
    const snap = budgetOrError.snapshot();
    return {
      partial: true,
      reason: BUDGET_EXCEEDED_REASON,
      task: snap.task,
      calls_used: snap.calls_used,
      calls_remaining: snap.calls_remaining,
    };
  }
  return {
    partial: true,
    reason: BUDGET_EXCEEDED_REASON,
    task: budgetOrError?.task || "",
    calls_used: Number(budgetOrError?.calls_used || 0),
    calls_remaining: Number(budgetOrError?.calls_remaining || 0),
  };
}

/**
 * Fail a trend request when budget is exhausted without a complete result.
 * Carries the partial marker on the Error so API layers do not save/charge.
 */
function throwBudgetExceeded(budgetOrError = null) {
  const partial = buildBudgetExceededPartial(budgetOrError);
  const error = createBudgetExceededError(
    partial.task || "trend_analysis",
    partial.calls_used,
    Number(budgetOrError?.maxCalls || partial.calls_used || 0),
  );
  error.calls_used = partial.calls_used;
  error.calls_remaining = partial.calls_remaining;
  error.partialResult = partial;
  throw error;
}

module.exports = {
  DEFAULT_BUDGETS,
  BUDGET_EXCEEDED_REASON,
  createAiCallBudget,
  createBudgetExceededError,
  isAiCallBudgetExceededError,
  buildBudgetExceededPartial,
  throwBudgetExceeded,
};
