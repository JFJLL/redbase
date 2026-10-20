"use strict";

const CATALOG_VERSION = "v2_20261016";

const PLANS = Object.freeze([
  {
    id: "light",
    rank: 1,
    name: "轻量版",
    label: "轻量创作",
    icon: "leaf",
    desc: "个人运营、单品牌的轻量内容创作",
    monthlyFen: 29900,
    annualFen: 299000,
    credits: 100,
    featured: false,
  },
  {
    id: "pro",
    rank: 2,
    name: "专业版",
    label: "持续创作",
    icon: "spark",
    desc: "持续运营品牌，把创作融入日常",
    monthlyFen: 99900,
    annualFen: 999000,
    credits: 400,
    featured: true,
  },
  {
    id: "business",
    rank: 3,
    name: "业务版",
    label: "高频创作",
    icon: "layers",
    desc: "多项目、高频率的内容生产需求",
    monthlyFen: 299900,
    annualFen: 2999000,
    credits: 1500,
    featured: false,
  },
]);

const TOPUPS = Object.freeze([
  {
    id: "fuel-small",
    name: "小额加油包",
    desc: "偶尔创作，轻松补充一点灵感",
    credits: 25,
    amountFen: 9900,
    icon: "bolt",
    featured: false,
  },
  {
    id: "fuel-standard",
    name: "标准加油包",
    desc: "灵活补充，让正在进行的创作继续",
    credits: 80,
    amountFen: 29900,
    icon: "bolt",
    featured: true,
  },
  {
    id: "fuel-large",
    name: "大额加油包",
    desc: "为阶段性项目，预留充足创作空间",
    credits: 300,
    amountFen: 99900,
    icon: "layers",
    featured: false,
  },
]);

const LEGACY_PLANS = Object.freeze([
  {
    id: "business-monthly",
    name: "单月版",
    credits: 1000,
    amountFen: 350000,
  },
  {
    id: "business-annual",
    name: "包年版",
    credits: 12000,
    amountFen: 3500000,
  },
]);

function getPlan(id) {
  return PLANS.find((p) => p.id === id) || null;
}

function getTopup(id) {
  return TOPUPS.find((p) => p.id === id) || null;
}

function getPriceFen(plan, cycle) {
  if (!plan) return 0;
  return cycle === "annual" ? plan.annualFen : plan.monthlyFen;
}

function isV2Plan(id) {
  return PLANS.some((p) => p.id === id);
}

function isV2Topup(id) {
  return TOPUPS.some((p) => p.id === id);
}

function getLegacyPlan(id) {
  return LEGACY_PLANS.find((p) => p.id === id) || null;
}

module.exports = {
  CATALOG_VERSION,
  PLANS,
  TOPUPS,
  LEGACY_PLANS,
  getPlan,
  getTopup,
  getPriceFen,
  isV2Plan,
  isV2Topup,
  getLegacyPlan,
};
