"use strict";

const crypto = require("crypto");
const { getSmsProvider } = require("../integrations/sms");
const {
  findVerificationChallenge,
  upsertVerificationChallenge,
  incrementSmsRateLimit,
} = require("../db/repositories/auth-repository");
const { maskPhone } = require("../api/http-utils");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function generateVerificationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hmacVerificationCode(pepper, purpose, phone, code) {
  return crypto
    .createHmac("sha256", String(pepper || ""))
    .update(`${String(purpose || "")}:${String(phone || "")}:${String(code || "")}`)
    .digest("base64");
}

function hmacIp(pepper, ip) {
  return crypto
    .createHmac("sha256", String(pepper || ""))
    .update(`ip:${String(ip || "")}`)
    .digest("hex");
}

function getClientIp(req, trustedProxies = []) {
  const socketIp = String(req?.socket?.remoteAddress || "").trim();
  const forwardedFor = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const trusted = new Set((Array.isArray(trustedProxies) ? trustedProxies : []).map((item) => String(item || "").trim()).filter(Boolean));
  if (forwardedFor && trusted.has(socketIp)) return forwardedFor;
  return socketIp || "unknown";
}

function getWindowStart(nowMs, windowMs) {
  return Math.floor(Number(nowMs || Date.now()) / windowMs) * windowMs;
}

function checkRateLimits({ appConfig, phone, ip, nowMs }) {
  const sms = appConfig?.sms || {};
  const limits = sms.limits || {};
  const pepper = String(sms.pepper || "");
  const hourStart = getWindowStart(nowMs, HOUR_MS);
  const dayStart = getWindowStart(nowMs, DAY_MS);
  const checks = [
    ["phone", phone, hourStart, limits.phonePerHour],
    ["phone", phone, dayStart, limits.phonePerDay],
    ["ip", hmacIp(pepper, ip), hourStart, limits.ipPerHour],
    ["ip", hmacIp(pepper, ip), dayStart, limits.ipPerDay],
    ["global", "global", dayStart, limits.globalPerDay],
  ];
  for (const [scope, bucketKey, windowStartMs, limit] of checks) {
    if (Number(limit) <= 0) continue;
    if (!incrementSmsRateLimit(scope, bucketKey, windowStartMs, limit)) {
      return false;
    }
  }
  return true;
}

async function issueVerificationCode({ appConfig, purpose, phone, req, nowMs = Date.now() }) {
  const sms = appConfig?.sms || {};
  const provider = getSmsProvider(appConfig);
  if (!provider) {
    return { ok: false, status: 503, message: "短信验证码服务未启用" };
  }
  if (!sms.pepper) {
    return { ok: false, status: 503, message: "短信验证码服务未启用" };
  }
  const existing = findVerificationChallenge(purpose, phone);
  const cooldownMs = Number(sms.resendCooldownMs || 60 * 1000);
  if (existing && Number(existing.last_sent_at_ms || 0) > 0 && nowMs - Number(existing.last_sent_at_ms) < cooldownMs) {
    const retryAfterSec = Math.max(1, Math.ceil((Number(existing.last_sent_at_ms) + cooldownMs - nowMs) / 1000));
    return { ok: false, status: 429, message: "发送太频繁，请稍后再试", retryAfterSec };
  }
  const ip = getClientIp(req, appConfig.security?.trustedProxies);
  if (!checkRateLimits({ appConfig, phone, ip, nowMs })) {
    return { ok: false, status: 429, message: "发送太频繁，请稍后再试" };
  }

  const code = generateVerificationCode();
  let sent;
  try {
    sent = await provider.sendCode({ phone, code });
  } catch (error) {
    console.warn("[sms] send failed", {
      phone: maskPhone(phone),
      purpose,
      error: String(error?.message || error),
    });
    return { ok: false, status: 502, message: "短信发送失败，请稍后重试" };
  }
  if (!sent?.ok) {
    console.warn("[sms] send rejected", { phone: maskPhone(phone), purpose });
    return { ok: false, status: 502, message: "短信发送失败，请稍后重试" };
  }

  upsertVerificationChallenge({
    purpose,
    phone,
    codeHmac: hmacVerificationCode(sms.pepper, purpose, phone, code),
    expiresAtMs: nowMs + Number(sms.codeTtlMs || 5 * 60 * 1000),
    nowMs,
  });
  return {
    ok: true,
    message: purpose === "reset_password" ? "验证码已发送，5 分钟内有效。" : "验证码已发送，5 分钟内有效。",
    demoCode: sent.demoCode,
  };
}

module.exports = {
  generateVerificationCode,
  hmacVerificationCode,
  hmacIp,
  getClientIp,
  getWindowStart,
  issueVerificationCode,
};
