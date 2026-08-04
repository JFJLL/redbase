"use strict";

// Strict decimal amount -> fen conversion. Never use float arithmetic for
// money: amounts are handled as strings with at most two decimal places.
function parseAmountYuanToFen(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("金额不能为空");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`金额格式不正确：${raw}`);
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  const padded = `${fraction}00`.slice(0, 2);
  const fen = Number(whole) * 100 + Number(padded);
  if (!Number.isSafeInteger(fen) || fen <= 0) {
    throw new Error(`金额必须为正整数分值：${raw}`);
  }
  return fen;
}

function fenToYuanString(fen) {
  const value = Number(fen);
  if (!Number.isSafeInteger(value) || value < 0) return "0.00";
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function normalizeRechargePlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  const id = String(plan.id || "").trim();
  const name = String(plan.name || "").trim();
  const credits = Number(plan.credits);
  if (!id || !name || !Number.isSafeInteger(credits) || credits <= 0) return null;
  let amountFen = Number(plan.amountFen);
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    try {
      amountFen = parseAmountYuanToFen(plan.amountYuan);
    } catch (error) {
      return null;
    }
  }
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) return null;
  return { id, name, credits, amountFen };
}

module.exports = {
  parseAmountYuanToFen,
  fenToYuanString,
  normalizeRechargePlan,
};
