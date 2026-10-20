"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { VERSIONED_MIGRATIONS, applyVersionedMigrations } = require("../../src/server/db/migrations");
const { getPlan, getPriceFen } = require("../../src/server/billing/catalog");
const {
  setNowGetter,
  resetNowGetter,
  getNowTimestamp,
  getNowIso,
  addCalendarMonths,
} = require("../../src/server/billing/period-utils");
const { createQuote } = require("../../src/server/billing/quote-service");
const { createCreditLot, getUserWalletBalances } = require("../../src/server/billing/credit-ledger");
const {
  fulfillPaymentOrder,
  advanceSubscriptionLifecycles,
  findActiveSubscription,
  findPendingSchedule,
} = require("../../src/server/billing/subscription-service");
const { insertUser, findUserById } = require("../../src/server/db/repositories/auth-repository");
const {
  insertPaymentOrder,
  settlePaidPaymentOrder,
  findPaymentOrderByOutTradeNo,
} = require("../../src/server/db/repositories/payment-repository");
const {
  inspectSubscriptionSnapshot,
  reconstructSubscriptionSnapshot,
  safeUpdateSubscriptionSnapshot,
} = require("../../src/server/billing/snapshot-recovery");

openDatabase();
initializeDatabaseSchema();
applyVersionedMigrations();
ensureDatabaseIndexes();
const db = getDbProxy();

let userSeq = 90000;
let orderSeq = 0;

function createTestUser(credits = 0, nowIso = new Date().toISOString()) {
  const id = ++userSeq;
  insertUser({
    id,
    name: `test-user-${id}`,
    phone: "138" + String(id).padStart(8, "0"),
    password: "fixture-pass",
    credits: 0,
    createdAt: nowIso,
  });
  db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(id);
  if (credits > 0) {
    createCreditLot(
      {
        userId: id,
        sourceType: "topup",
        sourceLabel: "测试储值",
        credits,
        startsAt: nowIso,
        expiresAt: null,
        nowIso,
      },
      db
    );
  }
  return id;
}

function placePlanOrder(userId, planId, cycle = "monthly", nowMs = getNowTimestamp()) {
  const quote = createQuote({ userId, kind: "plan", itemId: planId, cycle, nowMs });
  const outTradeNo = `ord_price_rev_${++orderSeq}_${Date.now()}`;
  const nowIso = new Date(nowMs).toISOString();
  const placed = insertPaymentOrder({
    outTradeNo,
    userId,
    idempotencyKey: outTradeNo,
    plan: getPlan(planId),
    provider: "test",
    quote,
    nowIso,
    expiresAtIso: new Date(nowMs + 900000).toISOString(),
  });
  return { quote, placed, outTradeNo };
}

function payOrder(orderObj, nowMs = getNowTimestamp()) {
  const nowIso = new Date(nowMs).toISOString();
  const result = settlePaidPaymentOrder({
    outTradeNo: orderObj.outTradeNo,
    tradeNo: `trade_${orderObj.outTradeNo}`,
    paidAt: nowIso,
    nowIso,
  });
  return result;
}

test("Finding 2 regression: upgrade fulfillment freezes purchased pricingBasisFen despite subsequent catalog price surge", () => {
  let simulatedNow = Date.parse("2026-03-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const lightOrder = placePlanOrder(uid, "light", "monthly", simulatedNow);
  payOrder(lightOrder, simulatedNow);

  const initialSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(initialSub.plan_id, "light");
  assert.equal(initialSub.pricing_basis_fen, 29900);
  const initialSnap = JSON.parse(initialSub.snapshot_json);
  assert.equal(initialSnap.pricingBasisFen, 29900);

  // Advance 5 days, user quotes and places upgrade order to Pro
  simulatedNow += 5 * 86400000;
  setNowGetter(() => simulatedNow);

  const upOrder = placePlanOrder(uid, "pro", "monthly", simulatedNow);
  const purchasedBasis = upOrder.placed.snapshot.pricingBasisFen;
  assert.equal(purchasedBasis, 99900);
  assert.equal(upOrder.placed.snapshot.meta.upgradeDetails.targetFullTermPrice, 99900);

  // Catalog price of Pro increases before payment settlement
  const proPlan = getPlan("pro");
  const originalMonthlyFen = proPlan.monthlyFen;
  proPlan.monthlyFen = 199900;

  try {
    const payResult = payOrder(upOrder, simulatedNow);
    assert.equal(payResult.order.fulfillmentStatus, "fulfilled");
  } finally {
    proPlan.monthlyFen = originalMonthlyFen;
  }

  // The subscription pricing basis must be the purchased basis (79900), NOT live catalog (199900)
  const upgradedSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(upgradedSub.plan_id, "pro");
  assert.equal(upgradedSub.pricing_basis_fen, 99900);
  const upgradedSnap = JSON.parse(upgradedSub.snapshot_json);
  assert.equal(upgradedSnap.pricingBasisFen, 99900);

  // Subsequent upgrade quote to Business calculates differential from purchased basis (79900)
  const nextQuote = createQuote({
    userId: uid,
    kind: "plan",
    itemId: "business",
    cycle: "monthly",
    nowMs: simulatedNow,
  });

  const businessPlan = getPlan("business");
  const ratio = nextQuote.meta.upgradeDetails.serviceRemainingMs / nextQuote.meta.upgradeDetails.serviceTotalMs;
  const expectedCharge = Math.round((businessPlan.monthlyFen - purchasedBasis) * ratio);

  assert.equal(nextQuote.amountFen, expectedCharge);
  assert.equal(nextQuote.meta.upgradeDetails.oldFullTermPrice, 99900);
  assert.equal(nextQuote.meta.upgradeDetails.targetFullTermPrice, businessPlan.monthlyFen);

  resetNowGetter();
});

test("Catalogue price change between quote creation and order persistence freezes quote targetFullTermPrice", () => {
  let simulatedNow = Date.parse("2026-04-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const lightOrder = placePlanOrder(uid, "light", "monthly", simulatedNow);
  payOrder(lightOrder, simulatedNow);

  // Create quote while Pro price is 79900
  const quote = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: simulatedNow });
  assert.equal(quote.meta.upgradeDetails.targetFullTermPrice, 99900);

  // Catalog increases before insertPaymentOrder is called
  const proPlan = getPlan("pro");
  const originalMonthlyFen = proPlan.monthlyFen;
  proPlan.monthlyFen = 259900;

  let placed;
  const outTradeNo = `ord_price_freeze_${Date.now()}`;
  try {
    placed = insertPaymentOrder({
      outTradeNo,
      userId: uid,
      idempotencyKey: outTradeNo,
      plan: proPlan,
      provider: "test",
      quote,
      nowIso: new Date(simulatedNow).toISOString(),
      expiresAtIso: new Date(simulatedNow + 900000).toISOString(),
    });
  } finally {
    proPlan.monthlyFen = originalMonthlyFen;
  }

  // Order snapshot must freeze 79900, not 259900
  assert.equal(placed.snapshot.pricingBasisFen, 99900);
  assert.equal(placed.snapshot.targetMonthlyCredits, 400);

  // Settling payment fulfills with frozen pricingBasisFen
  const payResult = settlePaidPaymentOrder({
    outTradeNo,
    tradeNo: `trade_${outTradeNo}`,
    paidAt: new Date(simulatedNow).toISOString(),
    nowIso: new Date(simulatedNow).toISOString(),
  });
  assert.equal(payResult.order.fulfillmentStatus, "fulfilled");

  const sub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(sub.pricing_basis_fen, 99900);
  const subSnap = JSON.parse(sub.snapshot_json);
  assert.equal(subSnap.pricingBasisFen, 99900);

  resetNowGetter();
});

test("Annual upgrade flow preserves purchased annual basis across catalog modifications and chained upgrades", () => {
  let simulatedNow = Date.parse("2026-01-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const lightAnnualOrder = placePlanOrder(uid, "light", "annual", simulatedNow);
  payOrder(lightAnnualOrder, simulatedNow);

  const initialSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(initialSub.plan_id, "light");
  assert.equal(initialSub.cycle, "annual");
  assert.equal(initialSub.pricing_basis_fen, 299000);

  // Advance 60 days, quote upgrade to Pro annual
  simulatedNow += 60 * 86400000;
  setNowGetter(() => simulatedNow);
  advanceSubscriptionLifecycles(simulatedNow, db);

  const upAnnualOrder = placePlanOrder(uid, "pro", "annual", simulatedNow);
  const purchasedAnnualBasis = upAnnualOrder.placed.snapshot.pricingBasisFen;
  assert.equal(purchasedAnnualBasis, 999000);
  assert.equal(upAnnualOrder.placed.snapshot.meta.upgradeDetails.targetFullTermPrice, 999000);

  // Catalog annual price changes before payment
  const proPlan = getPlan("pro");
  const savedAnnualFen = proPlan.annualFen;
  proPlan.annualFen = 1599000;

  try {
    const payResult = payOrder(upAnnualOrder, simulatedNow);
    assert.equal(payResult.order.fulfillmentStatus, "fulfilled");
  } finally {
    proPlan.annualFen = savedAnnualFen;
  }

  const upgradedSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(upgradedSub.plan_id, "pro");
  assert.equal(upgradedSub.pricing_basis_fen, 999000);
  const snap = JSON.parse(upgradedSub.snapshot_json);
  assert.equal(snap.pricingBasisFen, 999000);
  assert.equal(snap.monthlyCredits, 400);

  // Next upgrade quote to Business annual bases priceDiff on 799000
  const businessAnnualQuote = createQuote({
    userId: uid,
    kind: "plan",
    itemId: "business",
    cycle: "annual",
    nowMs: simulatedNow,
  });
  assert.equal(businessAnnualQuote.meta.upgradeDetails.oldFullTermPrice, 999000);
  assert.equal(businessAnnualQuote.meta.upgradeDetails.targetFullTermPrice, getPlan("business").annualFen);

  resetNowGetter();
});

test("Delayed fulfillment across period boundary sets purchased pricing basis and tops up current grant", () => {
  let simulatedNow = Date.parse("2026-05-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const lightOrder = placePlanOrder(uid, "light", "annual", simulatedNow);
  payOrder(lightOrder, simulatedNow);

  // User creates upgrade order to Pro annual on day 25
  simulatedNow += 25 * 86400000;
  setNowGetter(() => simulatedNow);
  const upOrder = placePlanOrder(uid, "pro", "annual", simulatedNow);

  // User pays on day 28 (strictly before month 1 ends)
  simulatedNow += 3 * 86400000;
  setNowGetter(() => simulatedNow);
  const paidAt = new Date(simulatedNow).toISOString();

  // Payment order status set to paid, but fulfillment delayed until month 2 has started
  simulatedNow += 5 * 86400000; // Month 1 ended on June 1, we are now past June 1
  setNowGetter(() => simulatedNow);
  advanceSubscriptionLifecycles(simulatedNow, db);

  // Catalog price changes during the delay
  const proPlan = getPlan("pro");
  const savedAnnualFen = proPlan.annualFen;
  proPlan.annualFen = 1888000;

  let settleResult;
  try {
    settleResult = settlePaidPaymentOrder({
      outTradeNo: upOrder.outTradeNo,
      tradeNo: `trade_${upOrder.outTradeNo}`,
      paidAt,
      nowIso: new Date(simulatedNow).toISOString(),
    });
  } finally {
    proPlan.annualFen = savedAnnualFen;
  }

  assert.equal(settleResult.order.fulfillmentStatus, "fulfilled");

  const sub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(sub.plan_id, "pro");
  assert.equal(sub.pricing_basis_fen, 999000); // Purchased basis, NOT 1888000
  const subSnap = JSON.parse(sub.snapshot_json);
  assert.equal(subSnap.pricingBasisFen, 999000);
  assert.equal(subSnap.monthlyCredits, 400);

  resetNowGetter();
});

test("Missing authoritative historical price or quota strictly flags audit_required without guessing", () => {
  let simulatedNow = Date.parse("2026-06-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const lightOrder = placePlanOrder(uid, "light", "monthly", simulatedNow);
  payOrder(lightOrder, simulatedNow);

  const activeSub = findActiveSubscription(uid, simulatedNow, db);

  // Case A: Missing authoritative pricing basis
  const outTradeNoPrice = `ord_missing_price_${Date.now()}`;
  const snapshotNoPrice = {
    version: 2,
    kind: "plan",
    action: "upgrade",
    itemId: "pro",
    itemName: "专业版",
    cycle: "monthly",
    amountFen: 15000,
    pricingBasisFen: 0,
    monthlyCredits: 400,
    targetMonthlyCredits: 400,
    issuedNow: 50,
    originalSubscriptionId: activeSub.id,
    originalPlanId: "light",
    meta: {},
  };

  db.prepare(`
    INSERT INTO payment_orders (
      out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits,
      amount_fen, status, provider, created_at, updated_at, expires_at,
      quote_id, fulfillment_status, cycle, order_kind, order_action,
      issued_now, service_start, service_end, period_end, snapshot_json, anchor_day
    ) VALUES (?, ?, ?, 'pro', '专业版', 400, 15000, 'created', 'test', ?, ?, ?, 'q_fake_price', 'unfulfilled', 'monthly', 'plan', 'upgrade', 50, ?, ?, ?, ?, 1)
  `).run(
    outTradeNoPrice,
    uid,
    outTradeNoPrice,
    new Date(simulatedNow).toISOString(),
    new Date(simulatedNow).toISOString(),
    new Date(simulatedNow + 900000).toISOString(),
    activeSub.service_start,
    activeSub.service_end,
    activeSub.current_period_end,
    JSON.stringify(snapshotNoPrice)
  );

  const settlePriceResult = settlePaidPaymentOrder({
    outTradeNo: outTradeNoPrice,
    tradeNo: `trade_${outTradeNoPrice}`,
    paidAt: new Date(simulatedNow).toISOString(),
    nowIso: new Date(simulatedNow).toISOString(),
  });

  assert.equal(settlePriceResult.order.fulfillmentStatus, "audit_required");
  assert.equal(settlePriceResult.order.auditReason, "缺少权威历史计费基准，需人工核查");

  // Case B: Missing authoritative quota
  const outTradeNoQuota = `ord_missing_quota_${Date.now()}`;
  const snapshotNoQuota = {
    version: 2,
    kind: "plan",
    action: "upgrade",
    itemId: "pro",
    itemName: "专业版",
    cycle: "monthly",
    amountFen: 20000,
    pricingBasisFen: 99900,
    monthlyCredits: 0,
    targetMonthlyCredits: 0,
    issuedNow: 50,
    originalSubscriptionId: activeSub.id,
    originalPlanId: "light",
    meta: {
      targetFullTermPrice: 99900,
    },
  };

  db.prepare(`
    INSERT INTO payment_orders (
      out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits,
      amount_fen, status, provider, created_at, updated_at, expires_at,
      quote_id, fulfillment_status, cycle, order_kind, order_action,
      issued_now, service_start, service_end, period_end, snapshot_json, anchor_day
    ) VALUES (?, ?, ?, 'pro', '专业版', 0, 20000, 'created', 'test', ?, ?, ?, 'q_fake_quota', 'unfulfilled', 'monthly', 'plan', 'upgrade', 50, ?, ?, ?, ?, 1)
  `).run(
    outTradeNoQuota,
    uid,
    outTradeNoQuota,
    new Date(simulatedNow).toISOString(),
    new Date(simulatedNow).toISOString(),
    new Date(simulatedNow + 900000).toISOString(),
    activeSub.service_start,
    activeSub.service_end,
    activeSub.current_period_end,
    JSON.stringify(snapshotNoQuota)
  );

  const settleQuotaResult = settlePaidPaymentOrder({
    outTradeNo: outTradeNoQuota,
    tradeNo: `trade_${outTradeNoQuota}`,
    paidAt: new Date(simulatedNow).toISOString(),
    nowIso: new Date(simulatedNow).toISOString(),
  });

  assert.equal(settleQuotaResult.order.fulfillmentStatus, "audit_required");
  assert.equal(settleQuotaResult.order.auditReason, "缺少权威套餐配额快照，需人工核查");

  const unchangedSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(unchangedSub.plan_id, "light");
  assert.equal(unchangedSub.pricing_basis_fen, 29900);

  resetNowGetter();
});

test("Pricing basis alignment: subscriptions.pricing_basis_fen column strictly equals snapshot_json.pricingBasisFen across activate, upgrade, and schedule", () => {
  let simulatedNow = Date.parse("2026-08-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());

  // 1. Activation
  const act = placePlanOrder(uid, "pro", "monthly", simulatedNow);
  payOrder(act, simulatedNow);
  const sub1 = findActiveSubscription(uid, simulatedNow, db);
  const snap1 = JSON.parse(sub1.snapshot_json);
  assert.equal(sub1.pricing_basis_fen, snap1.pricingBasisFen);
  assert.equal(sub1.pricing_basis_fen, 99900);

  // 2. Upgrade
  simulatedNow += 10 * 86400000;
  setNowGetter(() => simulatedNow);
  const up = placePlanOrder(uid, "business", "monthly", simulatedNow);
  payOrder(up, simulatedNow);
  const sub2 = findActiveSubscription(uid, simulatedNow, db);
  const snap2 = JSON.parse(sub2.snapshot_json);
  assert.equal(sub2.pricing_basis_fen, snap2.pricingBasisFen);
  assert.equal(sub2.pricing_basis_fen, 299900);

  // 3. Interval change scheduled for next period
  const interval = placePlanOrder(uid, "pro", "annual", simulatedNow);
  payOrder(interval, simulatedNow);
  const sched = findPendingSchedule(uid, db);
  assert.ok(sched);
  const schedSnap = JSON.parse(sched.snapshot_json);
  assert.equal(schedSnap.pricingBasisFen, 999000);

  // Advance time past current subscription end to activate schedule
  simulatedNow = new Date(sub2.service_end).getTime() + 1000;
  setNowGetter(() => simulatedNow);
  advanceSubscriptionLifecycles(simulatedNow, db);

  const sub3 = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(sub3.plan_id, "pro");
  assert.equal(sub3.cycle, "annual");
  const snap3 = JSON.parse(sub3.snapshot_json);
  assert.equal(sub3.pricing_basis_fen, snap3.pricingBasisFen);
  assert.equal(sub3.pricing_basis_fen, 999000);

  resetNowGetter();
});

test("Consecutive upgrades: Light -> Pro -> Business freezes purchased pricing basis at each hop despite catalog fluctuations", () => {
  let simulatedNow = Date.parse("2026-09-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const lightOrder = placePlanOrder(uid, "light", "monthly", simulatedNow);
  payOrder(lightOrder, simulatedNow);

  // Day 5: upgrade to Pro
  simulatedNow += 5 * 86400000;
  setNowGetter(() => simulatedNow);
  const proOrder = placePlanOrder(uid, "pro", "monthly", simulatedNow);
  assert.equal(proOrder.placed.snapshot.pricingBasisFen, 99900);

  // Catalog Pro price changes before Pro payment
  const proPlan = getPlan("pro");
  const savedProMonthly = proPlan.monthlyFen;
  proPlan.monthlyFen = 159900;
  try {
    payOrder(proOrder, simulatedNow);
  } finally {
    proPlan.monthlyFen = savedProMonthly;
  }

  const proSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(proSub.plan_id, "pro");
  assert.equal(proSub.pricing_basis_fen, 99900);

  // Day 12: upgrade from Pro to Business
  simulatedNow += 7 * 86400000;
  setNowGetter(() => simulatedNow);
  const bizOrder = placePlanOrder(uid, "business", "monthly", simulatedNow);
  assert.equal(bizOrder.placed.snapshot.pricingBasisFen, 299900);

  // Catalog Business price changes before Business payment
  const bizPlan = getPlan("business");
  const savedBizMonthly = bizPlan.monthlyFen;
  bizPlan.monthlyFen = 499900;
  try {
    payOrder(bizOrder, simulatedNow);
  } finally {
    bizPlan.monthlyFen = savedBizMonthly;
  }

  const bizSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(bizSub.plan_id, "business");
  assert.equal(bizSub.pricing_basis_fen, 299900);
  const bizSnap = JSON.parse(bizSub.snapshot_json);
  assert.equal(bizSnap.pricingBasisFen, 299900);
  assert.equal(bizSnap.monthlyCredits, 1500);

  resetNowGetter();
});

test("Provenance reconciliation handoff: detects stored drift between subscription pricing_basis_fen and canonical order snapshot", () => {
  let simulatedNow = Date.parse("2026-10-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const lightOrder = placePlanOrder(uid, "light", "monthly", simulatedNow);
  payOrder(lightOrder, simulatedNow);

  simulatedNow += 5 * 86400000;
  setNowGetter(() => simulatedNow);
  const proOrder = placePlanOrder(uid, "pro", "monthly", simulatedNow);
  payOrder(proOrder, simulatedNow);

  const sub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(sub.pricing_basis_fen, 99900);

  // Simulate historical drift: an earlier bug polluted subscriptions.pricing_basis_fen with live catalog (199900)
  db.prepare("UPDATE subscriptions SET pricing_basis_fen = 199900 WHERE id = ?").run(sub.id);
  const driftedSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(driftedSub.pricing_basis_fen, 199900);

  // Canonical snapshot recovery proves true purchased basis from the fulfilled order chain
  const inspection = inspectSubscriptionSnapshot(driftedSub, db);
  assert.equal(inspection.status, "resolved");
  assert.equal(inspection.snapshot.planId, "pro");
  assert.equal(inspection.snapshot.pricingBasisFen, 99900); // Canonical basis is 99900, not 199900!

  // Safe reconciliation handoff: updating pricing_basis_fen column from canonical snapshot resolves the drift
  db.prepare("UPDATE subscriptions SET pricing_basis_fen = ? WHERE id = ?").run(inspection.snapshot.pricingBasisFen, sub.id);
  const healedSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(healedSub.pricing_basis_fen, 99900);

  resetNowGetter();
});

test("Non-upgrade activation positive control: quote->persist preserves quoted price despite catalog change before order creation", () => {
  let simulatedNow = Date.parse("2026-11-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());

  // 1. User generates activation quote while Pro monthly is 99900
  const quote = createQuote({
    userId: uid,
    kind: "plan",
    itemId: "pro",
    cycle: "monthly",
    nowMs: simulatedNow,
  });
  assert.equal(quote.action, "activate");
  assert.equal(quote.amountFen, 99900);

  // 2. Catalog price of Pro surges to 159900 before order is persisted
  const proPlan = getPlan("pro");
  const originalMonthly = proPlan.monthlyFen;
  proPlan.monthlyFen = 159900;

  let placed;
  const outTradeNo = `ord_act_freeze_${Date.now()}`;
  try {
    placed = insertPaymentOrder({
      outTradeNo,
      userId: uid,
      idempotencyKey: outTradeNo,
      plan: proPlan,
      provider: "test",
      quote,
      nowIso: new Date(simulatedNow).toISOString(),
      expiresAtIso: new Date(simulatedNow + 900000).toISOString(),
    });
  } finally {
    proPlan.monthlyFen = originalMonthly;
  }

  // 3. Persisted order snapshot freezes the quoted 99900 fen, NOT 159900
  assert.equal(placed.snapshot.pricingBasisFen, 99900);
  assert.equal(placed.snapshot.amountFen, 99900);

  // 4. Payment settlement applies the frozen 99900 fen
  const payResult = settlePaidPaymentOrder({
    outTradeNo,
    tradeNo: `trade_${outTradeNo}`,
    paidAt: new Date(simulatedNow).toISOString(),
    nowIso: new Date(simulatedNow).toISOString(),
  });
  assert.equal(payResult.order.fulfillmentStatus, "fulfilled");

  const sub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(sub.plan_id, "pro");
  assert.equal(sub.pricing_basis_fen, 99900);
  const snap = JSON.parse(sub.snapshot_json);
  assert.equal(snap.pricingBasisFen, 99900);

  resetNowGetter();
});

test("Non-upgrade renewal positive control: quote->persist preserves quoted price despite catalog change before order creation", () => {
  let simulatedNow = Date.parse("2026-12-01T00:00:00.000Z");
  setNowGetter(() => simulatedNow);

  const uid = createTestUser(0, new Date(simulatedNow).toISOString());
  const initOrder = placePlanOrder(uid, "pro", "monthly", simulatedNow);
  payOrder(initOrder, simulatedNow);
  const activeSub = findActiveSubscription(uid, simulatedNow, db);

  // 1. User generates renewal quote for next period while Pro monthly is 99900
  const quote = createQuote({
    userId: uid,
    kind: "plan",
    itemId: "pro",
    cycle: "monthly",
    nowMs: simulatedNow,
  });
  assert.equal(quote.action, "renew");
  assert.equal(quote.scheduled, true);
  assert.equal(quote.amountFen, 99900);

  // 2. Catalog price of Pro surges to 189900 before order is persisted
  const proPlan = getPlan("pro");
  const originalMonthly = proPlan.monthlyFen;
  proPlan.monthlyFen = 189900;

  let placed;
  const outTradeNo = `ord_renew_freeze_${Date.now()}`;
  try {
    placed = insertPaymentOrder({
      outTradeNo,
      userId: uid,
      idempotencyKey: outTradeNo,
      plan: proPlan,
      provider: "test",
      quote,
      nowIso: new Date(simulatedNow).toISOString(),
      expiresAtIso: new Date(simulatedNow + 900000).toISOString(),
    });
  } finally {
    proPlan.monthlyFen = originalMonthly;
  }

  // 3. Persisted order snapshot freezes the quoted 99900 fen
  assert.equal(placed.snapshot.pricingBasisFen, 99900);
  assert.equal(placed.snapshot.amountFen, 99900);

  // 4. Payment settlement creates schedule with frozen pricing basis
  const payResult = settlePaidPaymentOrder({
    outTradeNo,
    tradeNo: `trade_${outTradeNo}`,
    paidAt: new Date(simulatedNow).toISOString(),
    nowIso: new Date(simulatedNow).toISOString(),
  });
  assert.equal(payResult.order.fulfillmentStatus, "scheduled");

  const sched = findPendingSchedule(uid, db);
  assert.ok(sched);
  const schedSnap = JSON.parse(sched.snapshot_json);
  assert.equal(schedSnap.pricingBasisFen, 99900);

  // 5. Advance time to activate the schedule
  simulatedNow = new Date(activeSub.service_end).getTime() + 1000;
  setNowGetter(() => simulatedNow);
  advanceSubscriptionLifecycles(simulatedNow, db);

  const nextSub = findActiveSubscription(uid, simulatedNow, db);
  assert.equal(nextSub.pricing_basis_fen, 99900);
  const nextSnap = JSON.parse(nextSub.snapshot_json);
  assert.equal(nextSnap.pricingBasisFen, 99900);

  resetNowGetter();
});
