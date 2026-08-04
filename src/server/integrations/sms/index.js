"use strict";

// SMS provider adapters. The production provider (aliyun) is disabled by
// default and only active with explicit credentials. Fake is allowed only
// when NODE_ENV=test AND sms.fakeAllowed=true (explicit injection).

const providerCache = new WeakMap();

class FakeSmsProvider {
  constructor() {
    this.sentByPhone = new Map();
    this.failNext = false;
  }

  async sendCode({ phone, code }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fake provider unavailable");
    }
    this.sentByPhone.set(String(phone || ""), {
      code: String(code || ""),
      sentAt: Date.now(),
    });
    return { ok: true, demoCode: String(code || "") };
  }

  getLastCode(phone) {
    return this.sentByPhone.get(String(phone || ""))?.code || "";
  }

  reset() {
    this.sentByPhone.clear();
    this.failNext = false;
  }
}

class AliyunSmsProvider {
  constructor(config) {
    this.config = config;
    this.client = null;
  }

  getClient() {
    if (this.client) return this.client;
    const Dysmsapi = require("@alicloud/dysmsapi20170525");
    const ClientClass = Dysmsapi.default || Dysmsapi;
    this.client = new ClientClass({
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      endpoint: this.config.endpoint || "dysmsapi.aliyuncs.com",
    });
    return this.client;
  }

  async sendCode({ phone, code }) {
    const Dysmsapi = require("@alicloud/dysmsapi20170525");
    const request = new Dysmsapi.SendSmsRequest({
      phoneNumbers: String(phone || ""),
      signName: this.config.signName,
      templateCode: this.config.templateCode,
      templateParam: JSON.stringify({ code: String(code || "") }),
    });
    const response = await this.getClient().sendSms(request);
    const parsed = parseSendSmsResponse(response);
    if (!parsed.ok) {
      throw new Error(`SMS provider returned ${parsed.code || "ERROR"}`);
    }
    return { ok: true };
  }
}

function parseSendSmsResponse(response) {
  const body = response?.body || response || {};
  return {
    ok: String(body?.code || "") === "OK",
    code: String(body?.code || ""),
    message: String(body?.message || ""),
  };
}

function isFakeAllowed(config) {
  return process.env.NODE_ENV === "test" && config?.fakeAllowed === true;
}

function createSmsProvider(appConfig) {
  const sms = appConfig?.sms || {};
  const providerName = String(sms.provider || "disabled").trim().toLowerCase();
  if (providerName === "fake") {
    if (!isFakeAllowed(sms)) return null;
    return new FakeSmsProvider();
  }
  if (providerName === "aliyun") {
    if (!sms.accessKeyId || !sms.accessKeySecret || !sms.signName || !sms.templateCode) return null;
    return new AliyunSmsProvider(sms);
  }
  return null;
}

function getSmsProvider(appConfig) {
  if (!appConfig || typeof appConfig !== "object") return null;
  if (!providerCache.has(appConfig)) {
    providerCache.set(appConfig, createSmsProvider(appConfig));
  }
  return providerCache.get(appConfig);
}

module.exports = {
  FakeSmsProvider,
  AliyunSmsProvider,
  parseSendSmsResponse,
  createSmsProvider,
  getSmsProvider,
  isFakeAllowed,
};
