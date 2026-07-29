const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-billing-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "billing.sqlite");

const { openDatabase } = require("../../src/server/db/connection");
const {
  initializeDatabaseSchema,
  ensureDatabaseIndexes,
  ensureSchemaUpgrades,
} = require("../../src/server/db/schema");
const { insertUser, findUserById, updateUserCredits } = require("../../src/server/db/repositories/auth-repository");
const {
  EXCELLENT_BILLING_KIND_DIRECTION,
  EXCELLENT_BILLING_KIND_FUSION,
  DIRECTION_FREE_LIMIT,
  DIRECTION_FREE_WINDOW_MS,
  normalizeExcellentBillingRequestId,
  buildExcellentBillingSignature,
  findExcellentBillingRequest,
  reserveExcellentBillingRequest,
  settleExcellentBillingRequest,
  failExcellentBillingRequest,
  getDirectionBillingSnapshot,
} = require("../../src/server/db/repositories/excellent-remix-billing-repository");
const { listAllCreditEvents, trySpendCreditsWithEvent } = require("../../src/server/db/repositories/admin-repository");
const { reserveTrendAnalysisRequest } = require("../../src/server/db/repositories/trend-analysis-repository");
const { getDbProxy } = require("../../src/server/db/connection");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();

let nextUserId = 700;
function makeUser(credits) {
  nextUserId += 1;
  insertUser({
    id: nextUserId,
    name: `Billing ${nextUserId}`,
    phone: `139${String(nextUserId).padStart(8, "0")}`,
    password: "hash",
    accountType: "customer",
    credits,
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  return nextUserId;
}

let requestSeq = 0;
function rid() {
  requestSeq += 1;
  return `repo-req-${String(requestSeq).padStart(5, "0")}`;
}

const T0 = new Date("2026-07-29T08:00:00.000Z").getTime();
function at(offsetMs) {
  return new Date(T0 + offsetMs);
}

function signature(parts) {
  return buildExcellentBillingSignature({ v: 1, ...parts });
}

function directionEvent() {
  return { actionType: "excellentContentDirection", actionLabel: "优秀内容内容方向生成" };
}

function fusionEvent() {
  return { actionType: "excellentFusionPlan", actionLabel: "优秀内容融合方案生成" };
}

/** Reserve + settle one direction generation; returns settle result. */
function runDirection(userId, { sig, requestId = rid(), now, resultSource = "model", force = false }) {
  const reservation = reserveExcellentBillingRequest({
    requestId,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: sig,
    creditCost: 1,
    forceRegenerate: force,
    now,
  });
  assert.equal(reservation.status, "reserved", `expected reserved, got ${reservation.status}`);
  const settle = settleExcellentBillingRequest({
    requestId,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    resultSource,
    resultJson: JSON.stringify({ directions: [{ id: "d1" }], source: resultSource }),
    event: directionEvent(),
    now,
  });
  return { reservation, settle, requestId };
}

test("requestId format is enforced", () => {
  assert.equal(normalizeExcellentBillingRequestId("short"), "");
  assert.equal(normalizeExcellentBillingRequestId("ok-request-1"), "ok-request-1");
  assert.equal(normalizeExcellentBillingRequestId("bad space id"), "");
});

test("direction window: first 3 free across brands/notes, 4th charges 1, slide-out restores free", () => {
  const userId = makeUser(10);
  // 跨品牌/跨笔记：4 个不同签名，窗口按用户全局统计。
  const sigs = [1, 2, 3, 4].map((i) => signature({ userId, noteId: `note-${i}`, brandId: i }));
  for (let i = 0; i < 3; i += 1) {
    const { settle } = runDirection(userId, { sig: sigs[i], now: at(i * 1000) });
    assert.equal(settle.charged, false, `free run ${i + 1} must not charge`);
    assert.equal(settle.windowCount, i + 1);
  }
  assert.equal(findUserById(userId).credits, 10);
  const snapshotBefore4 = getDirectionBillingSnapshot(userId, at(3000));
  assert.equal(snapshotBefore4.nextChargeable, true);

  const fourth = runDirection(userId, { sig: sigs[3], now: at(4000) });
  assert.equal(fourth.reservation.willCharge, true);
  assert.equal(fourth.settle.charged, true);
  assert.equal(fourth.settle.creditCost, 1);
  assert.equal(findUserById(userId).credits, 9);
  assert.equal(fourth.settle.windowCount, 4);
  const chargeEvents = listAllCreditEvents().filter(
    (event) => event.userId === userId && event.actionType === "excellentContentDirection" && event.creditDelta < 0,
  );
  assert.equal(chargeEvents.length, 1);

  // 窗口滑出（5 分钟 + 5 秒后）：恢复免费。
  const later = at(4000 + DIRECTION_FREE_WINDOW_MS + 5000);
  const fifth = runDirection(userId, {
    sig: signature({ userId, noteId: "note-5", brandId: 9 }),
    now: later,
  });
  assert.equal(fifth.reservation.willCharge, false);
  assert.equal(fifth.settle.charged, false);
  assert.equal(findUserById(userId).credits, 9);
});

test("cache hit, fallback, failure and same-requestId replay never count or charge", () => {
  const userId = makeUser(10);
  const sig = signature({ userId, noteId: "cache-note", brandId: 1 });

  // 1) 成功模型结果占 1 次。
  const first = runDirection(userId, { sig, now: at(0) });
  assert.equal(first.settle.windowCount, 1);

  // 2) 同输入缓存命中：免费、不计次、不调模型（由调用方跳过生成）。
  const cacheRes = reserveExcellentBillingRequest({
    requestId: rid(),
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: sig,
    creditCost: 1,
    now: at(1000),
  });
  assert.equal(cacheRes.status, "cache");
  assert.deepEqual(cacheRes.result.directions, [{ id: "d1" }]);
  assert.equal(getDirectionBillingSnapshot(userId, at(1000)).windowCount, 1);

  // 3) fallback：完成但不计次不扣分，也不会进入缓存。
  const fallbackSig = signature({ userId, noteId: "fallback-note", brandId: 1 });
  const fb = runDirection(userId, { sig: fallbackSig, now: at(2000), resultSource: "fallback" });
  assert.equal(fb.settle.charged, false);
  assert.equal(getDirectionBillingSnapshot(userId, at(2000)).windowCount, 1);
  const fbCache = reserveExcellentBillingRequest({
    requestId: rid(),
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: fallbackSig,
    creditCost: 1,
    now: at(3000),
  });
  assert.equal(fbCache.status, "reserved", "fallback result must not populate the 24h cache");
  failExcellentBillingRequest({ requestId: fbCache.request.request_id, userId, kind: EXCELLENT_BILLING_KIND_DIRECTION, error: "cleanup" });

  // 4) 失败：不计次不扣分，同 requestId 可重试。
  const failId = rid();
  const failSig = signature({ userId, noteId: "fail-note", brandId: 1 });
  reserveExcellentBillingRequest({
    requestId: failId,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: failSig,
    creditCost: 1,
    now: at(4000),
  });
  failExcellentBillingRequest({ requestId: failId, userId, kind: EXCELLENT_BILLING_KIND_DIRECTION, error: "model down" });
  assert.equal(getDirectionBillingSnapshot(userId, at(4000)).windowCount, 1);
  const retry = reserveExcellentBillingRequest({
    requestId: failId,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: failSig,
    creditCost: 1,
    now: at(5000),
  });
  assert.equal(retry.status, "reserved", "network retry with same requestId must be allowed after failure");
  settleExcellentBillingRequest({
    requestId: failId,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    resultSource: "model",
    resultJson: JSON.stringify({ directions: [{ id: "d2" }] }),
    event: directionEvent(),
    now: at(5000),
  });

  // 5) 同 requestId 重放：直接返回历史结果，不重复计次/扣分。
  const replay = reserveExcellentBillingRequest({
    requestId: first.requestId,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: sig,
    creditCost: 1,
    now: at(6000),
  });
  assert.equal(replay.status, "replay");
  assert.deepEqual(replay.result.directions, [{ id: "d1" }]);
  assert.equal(findUserById(userId).credits, 10, "no charge across cache/fallback/failure/replay");
});

test("concurrent 3rd/4th requests share only the remaining free slot; charged requestId settles once", () => {
  const userId = makeUser(10);
  const sigOf = (index) => signature({ userId, noteId: `race-${index}`, brandId: 1 });
  // 先占 2 个免费名额。
  runDirection(userId, { sig: sigOf(1), now: at(0) });
  runDirection(userId, { sig: sigOf(2), now: at(1000) });

  // 并发第 3、4 次：两个都先 reserve、后 settle。
  const idA = rid();
  const idB = rid();
  const reserveA = reserveExcellentBillingRequest({
    requestId: idA,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: sigOf(3),
    creditCost: 1,
    now: at(2000),
  });
  const reserveB = reserveExcellentBillingRequest({
    requestId: idB,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: sigOf(4),
    creditCost: 1,
    now: at(2001),
  });
  assert.equal(reserveA.willCharge, false, "3rd concurrent request takes the last free slot");
  assert.equal(reserveB.willCharge, true, "4th concurrent request cannot grab the same free slot");

  const settleA = settleExcellentBillingRequest({
    requestId: idA,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    resultSource: "model",
    resultJson: "{}",
    event: directionEvent(),
    now: at(2100),
  });
  const settleB = settleExcellentBillingRequest({
    requestId: idB,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    resultSource: "model",
    resultJson: "{}",
    event: directionEvent(),
    now: at(2101),
  });
  assert.equal(settleA.charged, false);
  assert.equal(settleB.charged, true);
  assert.equal(findUserById(userId).credits, 9);

  // 收费请求并发同 requestId：第二次 reserve 得到 pending，settle 重放不再扣费。
  const idC = rid();
  const reserveC = reserveExcellentBillingRequest({
    requestId: idC,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: sigOf(5),
    creditCost: 1,
    now: at(3000),
  });
  assert.equal(reserveC.willCharge, true);
  const duplicate = reserveExcellentBillingRequest({
    requestId: idC,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: sigOf(5),
    creditCost: 1,
    now: at(3001),
  });
  assert.equal(duplicate.status, "pending", "same requestId in flight must not reserve twice");
  settleExcellentBillingRequest({
    requestId: idC,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    resultSource: "model",
    resultJson: "{}",
    event: directionEvent(),
    now: at(3100),
  });
  const replaySettle = settleExcellentBillingRequest({
    requestId: idC,
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    resultSource: "model",
    resultJson: "{}",
    event: directionEvent(),
    now: at(3200),
  });
  assert.equal(replaySettle.replayed, true);
  assert.equal(replaySettle.charged, false);
  assert.equal(findUserById(userId).credits, 8, "duplicate settle must not double charge");
});

test("insufficient balance blocks reservation before any model call", () => {
  const userId = makeUser(0);
  // 填满窗口（免费额度用完）后第 4 次需要收费：余额 0 → insufficient。
  for (let i = 0; i < DIRECTION_FREE_LIMIT; i += 1) {
    runDirection(userId, { sig: signature({ userId, noteId: `poor-${i}`, brandId: 1 }), now: at(i * 1000) });
  }
  const blocked = reserveExcellentBillingRequest({
    requestId: rid(),
    userId,
    kind: EXCELLENT_BILLING_KIND_DIRECTION,
    inputSignature: signature({ userId, noteId: "poor-final", brandId: 1 }),
    creditCost: 1,
    now: at(5000),
  });
  assert.equal(blocked.status, "insufficient");

  // 融合：余额 0 直接拦截。
  const fusionBlocked = reserveExcellentBillingRequest({
    requestId: rid(),
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: signature({ userId, kind: "fusion", noteId: "poor-fusion" }),
    creditCost: 1,
    now: at(6000),
  });
  assert.equal(fusionBlocked.status, "insufficient");
});

test("fusion billing: AI settles 1, fallback/exception 0, cache replay 0, force regenerate charges again", () => {
  const userId = makeUser(5);
  const sig = signature({ userId, kind: "fusion", noteId: "fusion-note", brandId: 7 });

  // 有效 AI 方案：扣 1。
  const okId = rid();
  const reserveOk = reserveExcellentBillingRequest({
    requestId: okId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: at(0),
  });
  assert.equal(reserveOk.status, "reserved");
  assert.equal(reserveOk.willCharge, true, "new fusion generations always pre-reserve 1 credit");
  const settleOk = settleExcellentBillingRequest({
    requestId: okId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    resultSource: "model",
    resultJson: JSON.stringify({ contentGenerationMode: "ai", carouselPack: { slides: [1, 2, 3, 4] } }),
    event: fusionEvent(),
    now: at(100),
  });
  assert.equal(settleOk.charged, true);
  assert.equal(findUserById(userId).credits, 4);

  // 缓存命中重放：0。
  const cacheHit = reserveExcellentBillingRequest({
    requestId: rid(),
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: at(1000),
  });
  assert.equal(cacheHit.status, "cache");
  assert.equal(cacheHit.result.contentGenerationMode, "ai");
  assert.equal(findUserById(userId).credits, 4);

  // fallback：0。
  const fbId = rid();
  const fbSig = signature({ userId, kind: "fusion", noteId: "fusion-fb" });
  reserveExcellentBillingRequest({
    requestId: fbId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: fbSig,
    creditCost: 1,
    now: at(2000),
  });
  const settleFb = settleExcellentBillingRequest({
    requestId: fbId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    resultSource: "fallback",
    resultJson: JSON.stringify({ contentGenerationMode: "deterministic_fallback" }),
    event: fusionEvent(),
    now: at(2100),
  });
  assert.equal(settleFb.charged, false);
  assert.equal(findUserById(userId).credits, 4);

  // 异常：释放预占，0 扣费。
  const errId = rid();
  reserveExcellentBillingRequest({
    requestId: errId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: signature({ userId, kind: "fusion", noteId: "fusion-err" }),
    creditCost: 1,
    now: at(3000),
  });
  failExcellentBillingRequest({ requestId: errId, userId, kind: EXCELLENT_BILLING_KIND_FUSION, error: "timeout" });
  assert.equal(findExcellentBillingRequest({ requestId: errId, userId, kind: EXCELLENT_BILLING_KIND_FUSION }).status, "failed");
  assert.equal(findUserById(userId).credits, 4);

  // forceRegenerate：跳过缓存重新收 1。
  const forceId = rid();
  const forceReserve = reserveExcellentBillingRequest({
    requestId: forceId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    forceRegenerate: true,
    now: at(4000),
  });
  assert.equal(forceReserve.status, "reserved", "forceRegenerate must skip the 24h cache");
  const settleForce = settleExcellentBillingRequest({
    requestId: forceId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    resultSource: "model",
    resultJson: JSON.stringify({ contentGenerationMode: "ai", version: 2 }),
    event: fusionEvent(),
    now: at(4100),
  });
  assert.equal(settleForce.charged, true);
  assert.equal(findUserById(userId).credits, 3);
});

test("excellent reservations freeze balance for legacy spend paths and trend reservations", () => {
  const userId = makeUser(1);
  const requestId = rid();
  const reservationNow = new Date();
  const reservation = reserveExcellentBillingRequest({
    requestId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: signature({ userId, kind: "fusion", noteId: "freeze" }),
    creditCost: 1,
    now: reservationNow,
  });
  assert.equal(reservation.status, "reserved");

  // 逐页生图等既有扣分路径必须看到 excellent 预占，不能把被冻结的 1 分扣走。
  const blockedSpend = trySpendCreditsWithEvent({
    userId,
    amount: 1,
    event: { actionType: "xhsCarousel", actionLabel: "并发单页生图" },
  });
  assert.equal(blockedSpend.spent, false, "legacy spend path must respect excellent reservations");

  // 趋势预占同样被拦住。
  const db = getDbProxy();
  db.prepare(`
    INSERT INTO brands (id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base)
    VALUES (?, ?, '冻结测试品牌', '测试', '测试', '测试', '测试', '测试', '')
  `).run(9000 + userId, userId);
  const trendReserve = reserveTrendAnalysisRequest({
    requestId: `trend-${requestId}`,
    userId,
    brandId: 9000 + userId,
    bucketKey: "global",
    creditCost: 1,
  });
  assert.equal(trendReserve.status, "insufficient", "trend reservations must respect excellent reservations");

  // 释放 excellent 预占后，既有路径恢复可用。
  failExcellentBillingRequest({ requestId, userId, kind: EXCELLENT_BILLING_KIND_FUSION, error: "released" });
  const spendAfterRelease = trySpendCreditsWithEvent({
    userId,
    amount: 1,
    event: { actionType: "xhsCarousel", actionLabel: "释放后单页生图" },
  });
  assert.equal(spendAfterRelease.spent, true);
  assert.equal(findUserById(userId).credits, 0);
});

test("settle guards against balance drained after reservation and never goes negative", () => {
  const userId = makeUser(1);
  const requestId = rid();
  const reservation = reserveExcellentBillingRequest({
    requestId,
    userId,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: signature({ userId, kind: "fusion", noteId: "drain" }),
    creditCost: 1,
    now: at(0),
  });
  assert.equal(reservation.status, "reserved");
  // 预占后余额被外部扣光（例如管理员调整）。
  updateUserCredits(userId, 0);
  assert.throws(
    () =>
      settleExcellentBillingRequest({
        requestId,
        userId,
        kind: EXCELLENT_BILLING_KIND_FUSION,
        resultSource: "model",
        resultJson: "{}",
        event: fusionEvent(),
        now: at(100),
      }),
    /积分余额已发生变化/,
  );
  assert.equal(findUserById(userId).credits, 0, "balance must never go negative");
  assert.equal(
    findExcellentBillingRequest({ requestId, userId, kind: EXCELLENT_BILLING_KIND_FUSION }).status,
    "failed",
  );
});
