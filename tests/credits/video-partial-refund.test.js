process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const test = require("node:test");
const assert = require("node:assert/strict");
const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { applyVersionedMigrations } = require("../../src/server/db/migrations");
const { insertUser, findUserById } = require("../../src/server/db/repositories/auth-repository");
const { insertCreditEvent, spendCreditsWithEventInTransaction } = require("../../src/server/db/repositories/admin-repository");
const {
  createCreditLot,
  spendCreditsFromLots,
  getUserWalletBalances,
  rescanExpiredLots,
} = require("../../src/server/billing/credit-ledger");
const { setNowGetter, resetNowGetter, getNowIso } = require("../../src/server/billing/period-utils");
const { refundVideoCredits, sumVideoProjectRefundCredits, findRefundEvent } = require("../../src/server/video/video-billing");

openDatabase();
initializeDatabaseSchema();
applyVersionedMigrations();
ensureDatabaseIndexes();
const db = getDbProxy();

let mockNowMs = Date.parse("2026-01-01T00:00:00.000Z");
setNowGetter(() => mockNowMs);

let userSeq = 94000;
function makeUser(initialCredits = 0, { expiresAt = null, sourceType = "topup" } = {}) {
  const id = ++userSeq;
  const nowIso = getNowIso();
  insertUser({
    id,
    name: `user-${id}`,
    phone: `139${String(id).padStart(8, "0")}`,
    password: "pwd",
    credits: 0,
    createdAt: nowIso,
  });
  db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(id);
  let lotId = null;
  if (initialCredits > 0) {
    insertCreditEvent({
      userId: id,
      actionType: "system_grant",
      actionLabel: "系统发放",
      creditDelta: initialCredits,
      creditCost: 0,
      createdAt: nowIso,
    });
    lotId = Number(createCreditLot({
      userId: id,
      sourceType: expiresAt ? "cycle" : sourceType,
      sourceLabel: "fixture",
      credits: initialCredits,
      startsAt: nowIso,
      expiresAt,
      nowIso,
    }, db));
  }
  return { id, lotId };
}

function insertProjectFixture(ownerUserId, { projectId = null, generationId = null, chargedCredits = 60, status = "running" } = {}) {
  const now = getNowIso();
  const genId = generationId || ++userSeq;
  const projId = projectId || ++userSeq;

  db.prepare(`
    INSERT INTO generations (
      id, owner_user_id, type, channel_label, brand_id, brand_name,
      trend_id, trend_title, idea_title, card_title, created_at, preview_url, summary
    ) VALUES (?, ?, 'videoScript', '视频', 1, 'Brand', 1, 'Trend', 'Idea', 'Card', ?, '', '')
  `).run(genId, ownerUserId, now);

  db.prepare(`
    INSERT INTO video_projects (
      id, owner_user_id, generation_id, request_id, brand_id, trend_id,
      idea_index, video_model, mode, resolution, aspect_ratio,
      total_duration_sec, status, charged_credits, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1, 0, 'd2', 'text', '720p', '16:9', 10, ?, ?, ?, ?)
  `).run(projId, ownerUserId, genId, `req-${projId}`, status, chargedCredits, now, now);

  return { projectId: projId, generationId: genId };
}

function insertBillingRequestFixture({ userId, projectId, generationId, creditCost, creditEventId, status = "committed", createdAt = null }) {
  const now = createdAt || getNowIso();
  const res = db.prepare(`
    INSERT INTO video_project_billing_requests (
      request_id, user_id, project_id, generation_id, operation, status,
      credit_cost, credit_event_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'create', ?, ?, ?, ?, ?)
  `).run(`req-bill-${projectId}`, userId, projectId, generationId, status, creditCost, creditEventId, now, now);
  return res.lastInsertRowid;
}

test("Finding 1: partial refund restores only requested amount, not all allocations", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const event = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: uid, amount: 60, creditEventId: event.id, nowIso }, db);

  const before = findUserById(uid).credits;
  assert.equal(before, 40);

  const refund = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: event.id,
    refundRange: "3-3",
    projectId: 85001,
  });

  assert.equal(refund.refunded, true);
  assert.equal(refund.amount, 20);

  const after = findUserById(uid).credits;
  assert.equal(after - before, 20);
  assert.equal(after, 60);

  // Verify original credit_lot_allocations row is untouched (audit preserved)
  const allocs = db.prepare("SELECT * FROM credit_lot_allocations WHERE credit_event_id = ?").all(event.id);
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].credits_used, 60);

  // Verify lot state
  const lot = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(allocs[0].lot_id);
  assert.equal(lot.remaining_credits, 60);
  assert.equal(lot.used_credits, 40);

  // Verify refund event payload contains lotRefunds metadata
  const refundEvent = db.prepare("SELECT payload_json FROM credit_events WHERE id = ?").get(refund.eventId);
  const payload = JSON.parse(refundEvent.payload_json);
  assert.deepEqual(payload.lotRefunds, [{ lotId: lot.id, creditsRestored: 20 }]);
});

test("Multiple partial ranges: sequential refunds accumulate correctly up to charged ceiling", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const event = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: uid, amount: 60, creditEventId: event.id, nowIso }, db);

  // Insert corresponding billing request
  const { projectId: p85002, generationId: g85002 } = insertProjectFixture(uid, { projectId: 85002, chargedCredits: 60 });
  insertBillingRequestFixture({
    userId: uid,
    projectId: p85002,
    generationId: g85002,
    creditCost: 60,
    creditEventId: event.id,
    status: "committed",
    createdAt: nowIso,
  });

  // Step 1: refund clip 3 (20 credits)
  const r1 = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: event.id,
    refundRange: "3-3",
    projectId: 85002,
  });
  assert.equal(r1.refunded, true);
  assert.equal(r1.amount, 20);
  assert.equal(findUserById(uid).credits, 60);
  assert.equal(sumVideoProjectRefundCredits({ userId: uid, projectId: 85002 }), 20);

  let billing = db.prepare("SELECT status FROM video_project_billing_requests WHERE credit_event_id = ?").get(event.id);
  assert.equal(billing.status, "committed");

  // Step 2: refund clip 2 (20 credits)
  const r2 = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: event.id,
    refundRange: "2-2",
    projectId: 85002,
  });
  assert.equal(r2.refunded, true);
  assert.equal(r2.amount, 20);
  assert.equal(findUserById(uid).credits, 80);
  assert.equal(sumVideoProjectRefundCredits({ userId: uid, projectId: 85002 }), 40);

  billing = db.prepare("SELECT status FROM video_project_billing_requests WHERE credit_event_id = ?").get(event.id);
  assert.equal(billing.status, "committed");

  // Step 3: refund clip 1 (20 credits, completes the 60 total)
  const r3 = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: event.id,
    refundRange: "1-1",
    projectId: 85002,
  });
  assert.equal(r3.refunded, true);
  assert.equal(r3.amount, 20);
  assert.equal(findUserById(uid).credits, 100);
  assert.equal(sumVideoProjectRefundCredits({ userId: uid, projectId: 85002 }), 60);

  billing = db.prepare("SELECT status FROM video_project_billing_requests WHERE credit_event_id = ?").get(event.id);
  assert.equal(billing.status, "refunded");
});

test("Idempotent replay: identical refund key replays safely without side-effects", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const event = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: uid, amount: 60, creditEventId: event.id, nowIso }, db);

  const first = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: event.id,
    refundRange: "3-3",
    projectId: 85003,
  });
  assert.equal(first.refunded, true);
  assert.equal(first.amount, 20);

  const eventCountBefore = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRefund'").get(uid).count;
  assert.equal(eventCountBefore, 1);

  // Replay exact same request
  const replayed = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: event.id,
    refundRange: "3-3",
    projectId: 85003,
  });
  assert.equal(replayed.refunded, false);
  assert.equal(replayed.amount, 0);
  assert.equal(replayed.eventId, first.eventId);

  const eventCountAfter = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRefund'").get(uid).count;
  assert.equal(eventCountAfter, 1);
  assert.equal(findUserById(uid).credits, 60);
});

test("Overrefund prevention: exceeding charged ceiling is refused without issuing compensation", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const event = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: uid, amount: 60, creditEventId: event.id, nowIso }, db);

  // Refund 40 initially
  const r1 = refundVideoCredits({
    userId: uid,
    amount: 40,
    reservationCreditEventId: event.id,
    refundRange: "2-3",
    projectId: 85004,
  });
  assert.equal(r1.refunded, true);
  assert.equal(findUserById(uid).credits, 80);

  // Now attempt to refund 30 (40 + 30 = 70 > 60 total charged)
  const r2 = refundVideoCredits({
    userId: uid,
    amount: 30,
    reservationCreditEventId: event.id,
    refundRange: "1-1",
    projectId: 85004,
  });
  assert.equal(r2.refunded, false);
  assert.equal(r2.amount, 0);
  assert.equal(r2.code, "OVERREFUND_EXCEEDS_CHARGED");

  // Balance must remain 80, no compensation lot created
  assert.equal(findUserById(uid).credits, 80);
  const compensationLots = db.prepare("SELECT COUNT(*) AS count FROM credit_lots WHERE user_id = ? AND source_type = 'compensation'").get(uid).count;
  assert.equal(compensationLots, 0);
});

test("Overlapping ranges and same-millisecond replay protection", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const event = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: uid, amount: 60, creditEventId: event.id, nowIso }, db);

  // Refund range 1-2 (40 credits)
  const r1 = refundVideoCredits({
    userId: uid,
    amount: 40,
    reservationCreditEventId: event.id,
    refundRange: "1-2",
    projectId: 85010,
  });
  assert.equal(r1.refunded, true);
  assert.equal(findUserById(uid).credits, 80);

  // Same-millisecond immediate replay with identical key
  const replay = refundVideoCredits({
    userId: uid,
    amount: 40,
    reservationCreditEventId: event.id,
    refundRange: "1-2",
    projectId: 85010,
  });
  assert.equal(replay.refunded, false);
  assert.equal(replay.eventId, r1.eventId);
  assert.equal(findUserById(uid).credits, 80);

  // Overlapping second range 2-3 (40 credits) arriving:
  // total would be 40 + 40 = 80 > 60 total charged. Must be rejected.
  const overlap = refundVideoCredits({
    userId: uid,
    amount: 40,
    reservationCreditEventId: event.id,
    refundRange: "2-3",
    projectId: 85010,
  });
  assert.equal(overlap.refunded, false);
  assert.equal(overlap.code, "OVERLAPPING_REFUND_RANGE");
  assert.equal(findUserById(uid).credits, 80);
});

test("User scoping: cross-user reservation refund attempt is rejected", () => {
  const { id: userA } = makeUser(100);
  const { id: userB } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const eventA = insertCreditEvent({
    userId: userA,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: userA, amount: 60, creditEventId: eventA.id, nowIso }, db);

  // User B attempts to refund User A's reservation event
  const attempt = refundVideoCredits({
    userId: userB,
    amount: 20,
    reservationCreditEventId: eventA.id,
    refundRange: "1-1",
    projectId: 85005,
  });

  assert.equal(attempt.refunded, false);
  assert.equal(attempt.code, "USER_MISMATCH");
  assert.equal(findUserById(userA).credits, 40);
  assert.equal(findUserById(userB).credits, 100);
});

test("Mixed lots: partial refund restores across lots in LIFO order", () => {
  const id = ++userSeq;
  const nowIso = "2026-01-01T00:00:00.000Z";
  insertUser({ id, name: `user-${id}`, phone: `139${String(id).padStart(8, "0")}`, password: "pwd", credits: 0, createdAt: nowIso });
  db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(id);

  // Lot 1: 30 credits (expires sooner)
  const lot1Id = Number(createCreditLot({
    userId: id,
    sourceType: "cycle",
    sourceLabel: "lot1-cycle",
    credits: 30,
    startsAt: nowIso,
    expiresAt: "2026-01-15T00:00:00.000Z",
    nowIso,
  }, db));

  // Lot 2: 30 credits (expires later)
  const lot2Id = Number(createCreditLot({
    userId: id,
    sourceType: "cycle",
    sourceLabel: "lot2-cycle",
    credits: 30,
    startsAt: nowIso,
    expiresAt: "2026-01-30T00:00:00.000Z",
    nowIso,
  }, db));

  // Spend 50 credits across the lots (FIFO spends 30 from Lot 1, 20 from Lot 2)
  const event = insertCreditEvent({
    userId: id,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -50,
    creditCost: 50,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: id, amount: 50, creditEventId: event.id, nowIso }, db);
  assert.equal(findUserById(id).credits, 10);

  // Refund 25 credits.
  // LIFO restoration: Lot 2 was charged 20 -> receives 20 back. Lot 1 receives 5 back.
  const r1 = refundVideoCredits({
    userId: id,
    amount: 25,
    reservationCreditEventId: event.id,
    refundRange: "2-3",
    projectId: 85006,
  });
  assert.equal(r1.refunded, true);
  assert.equal(r1.amount, 25);
  assert.equal(findUserById(id).credits, 35);

  const l2State = db.prepare("SELECT remaining_credits, used_credits FROM credit_lots WHERE id = ?").get(lot2Id);
  assert.equal(l2State.remaining_credits, 30); // 10 original remaining + 20 restored = 30
  assert.equal(l2State.used_credits, 0); // 20 used - 20 restored = 0

  const l1State = db.prepare("SELECT remaining_credits, used_credits FROM credit_lots WHERE id = ?").get(lot1Id);
  assert.equal(l1State.remaining_credits, 5); // 0 original remaining + 5 restored = 5
  assert.equal(l1State.used_credits, 25); // 30 used - 5 restored = 25

  // Refund remaining 25 credits: goes entirely to Lot 1
  const r2 = refundVideoCredits({
    userId: id,
    amount: 25,
    reservationCreditEventId: event.id,
    refundRange: "1-1",
    projectId: 85006,
  });
  assert.equal(r2.refunded, true);
  assert.equal(findUserById(id).credits, 60);

  const l1Final = db.prepare("SELECT remaining_credits, used_credits FROM credit_lots WHERE id = ?").get(lot1Id);
  assert.equal(l1Final.remaining_credits, 30);
  assert.equal(l1Final.used_credits, 0);
});

test("Expired lot behavior: exact conservation equation and idempotency under repeated expiry scans", () => {
  const id = ++userSeq;
  const grantIso = "2026-01-01T00:00:00.000Z";
  const expiryIso = "2026-01-05T00:00:00.000Z";
  const pastExpiryMs = Date.parse("2026-01-10T00:00:00.000Z");

  insertUser({ id, name: `user-${id}`, phone: `139${String(id).padStart(8, "0")}`, password: "pwd", credits: 0, createdAt: grantIso });
  db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(id);

  // Seed proper initial grant ledger
  insertCreditEvent({
    userId: id,
    actionType: "system_grant",
    actionLabel: "系统发放",
    creditDelta: 100,
    creditCost: 0,
    createdAt: grantIso,
  });

  // Lot: 100 initial credits
  const lotId = Number(createCreditLot({
    userId: id,
    sourceType: "cycle",
    sourceLabel: "monthly",
    credits: 100,
    startsAt: grantIso,
    expiresAt: expiryIso,
    nowIso: grantIso,
  }, db));

  // Spend 60 while active (leaving 40 remaining, 60 used)
  const event = insertCreditEvent({
    userId: id,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: grantIso,
  });
  spendCreditsFromLots({ userId: id, amount: 60, creditEventId: event.id, nowIso: grantIso }, db);
  assert.equal(findUserById(id).credits, 40);

  setNowGetter(() => pastExpiryMs);
  try {
    // Natural expiry at T1: remaining 40 credits expire via rescanExpiredLots
    rescanExpiredLots(id, pastExpiryMs, db);
    assert.equal(findUserById(id).credits, 0);

    const lotAfterExpiry = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotId);
    assert.equal(lotAfterExpiry.status, "expired");
    assert.equal(lotAfterExpiry.remaining_credits, 0);
    assert.equal(lotAfterExpiry.used_credits, 60);

    const expireEvtsBefore = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").all(id);
    assert.equal(expireEvtsBefore.length, 1);
    assert.equal(expireEvtsBefore[0].credit_delta, -40);

    // Now at pastExpiryMs (after expiry), refund 20 credits
    const refund = refundVideoCredits({
      userId: id,
      amount: 20,
      reservationCreditEventId: event.id,
      refundRange: "3-3",
      projectId: 85007,
    });
    assert.equal(refund.refunded, true);
    assert.equal(refund.amount, 20);

    // Check that user wallet does NOT resurrect expired credits into active balance
    const wallet = getUserWalletBalances(id, pastExpiryMs, db);
    assert.equal(wallet.totalAvailable, 0);
    assert.equal(wallet.permanentBalance, 0);
    assert.equal(wallet.periodBalance, 0);
    assert.equal(findUserById(id).credits, 0);

    // Lot state: used_credits was reduced from 60 to 40, remaining stays 0, status is 'expired'
    const lotAfterRefund = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotId);
    assert.equal(lotAfterRefund.status, "expired");
    assert.equal(lotAfterRefund.remaining_credits, 0);
    assert.equal(lotAfterRefund.used_credits, 40);

    // Atomic cycle_expire event was inserted for the -20 expired refund
    const expireEvtsAfterRefund = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").all(id);
    assert.equal(expireEvtsAfterRefund.length, 2);
    const totalExpiredCredits = expireEvtsAfterRefund.reduce((s, e) => s + Math.abs(e.credit_delta), 0);
    assert.equal(totalExpiredCredits, 60); // 40 originally expired + 20 refund expired = 60

    // Exact accounting invariant: initial = available (0) + reserved (0) + used (40) + expired (60)
    assert.equal(
      lotAfterRefund.initial_credits,
      wallet.totalAvailable + wallet.totalReserved + lotAfterRefund.used_credits + totalExpiredCredits
    );

    // Exact event sum: +100 grant, -60 spend, -40 expire, +20 refund, -20 refund expire = 0 net
    const allEvents = db.prepare("SELECT action_type, credit_delta FROM credit_events WHERE user_id = ?").all(id);
    const eventSum = allEvents.reduce((s, e) => s + e.credit_delta, 0);
    assert.equal(eventSum, findUserById(id).credits); // both 0

    // Repeated expiry scans (scan 1, 2, 3) must be strictly idempotent and preserve exact equation
    for (let scan = 1; scan <= 3; scan++) {
      rescanExpiredLots(id, pastExpiryMs, db);
      const expireEvtsScanned = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").all(id);
      assert.equal(expireEvtsScanned.length, 2, `Scan ${scan} must not add duplicate cycle_expire events`);

      const scannedLot = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotId);
      assert.equal(scannedLot.remaining_credits, 0);
      assert.equal(scannedLot.used_credits, 40);

      const scannedSum = db.prepare("SELECT SUM(credit_delta) AS s FROM credit_events WHERE user_id = ?").get(id).s;
      assert.equal(scannedSum, 0);
      assert.equal(findUserById(id).credits, 0);
    }
  } finally {
    setNowGetter(() => mockNowMs);
  }
});

test("Migration-era boundary: historical refund row lacking lotRefunds requires manual audit and refuses automated double-restoration", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const event = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: uid, amount: 60, creditEventId: event.id, nowIso }, db);
  assert.equal(findUserById(uid).credits, 40);

  // Insert corresponding billing request
  const { projectId: p85008, generationId: g85008 } = insertProjectFixture(uid, { projectId: 85008, chargedCredits: 60 });
  const billingId = insertBillingRequestFixture({
    userId: uid,
    projectId: p85008,
    generationId: g85008,
    creditCost: 60,
    creditEventId: event.id,
    status: "committed",
    createdAt: nowIso,
  });

  // Simulate a historical buggy refund event written without lotRefunds
  insertCreditEvent({
    userId: uid,
    actionType: "videoProjectRefund",
    actionLabel: "AI 视频失败退款",
    creditDelta: 20,
    creditCost: 0,
    createdAt: nowIso,
    payload: {
      projectId: 85008,
      reservationCreditEventId: event.id,
      refundRange: "3-3",
      refundKey: `video-project:85008:reservation:${event.id}:range:3-3`,
      refundReason: "video clip failed",
      refundedAt: nowIso,
      // Notice: NO lotRefunds metadata!
    },
  });

  // A subsequent refund attempt for range "2-2" comes in
  const subsequent = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: event.id,
    refundRange: "2-2",
    projectId: 85008,
  });

  // Must be refused with HISTORICAL_REFUND_NEEDS_AUDIT rather than blindly restoring another 20
  assert.equal(subsequent.refunded, false);
  assert.equal(subsequent.code, "HISTORICAL_REFUND_NEEDS_AUDIT");
  assert.equal(subsequent.auditRequired, true);
  assert.equal(findUserById(uid).credits, 40);

  // Billing request status must be updated to audit_required
  const updatedBilling = db.prepare("SELECT status FROM video_project_billing_requests WHERE id = ?").get(billingId);
  assert.equal(updatedBilling.status, "audit_required");
});

test("Negative test: grant-positive event cannot be used as charged proof", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  // User received a grant (creditDelta > 0)
  const grantEvent = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "grant",
    creditDelta: 60,
    creditCost: 0,
    createdAt: nowIso,
  });

  const attempt = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: grantEvent.id,
    refundRange: "1-1",
    projectId: 85009,
  });

  assert.equal(attempt.refunded, false);
  assert.equal(attempt.code, "INVALID_ORIGINAL_EVENT");
  assert.equal(findUserById(uid).credits, 100);
});

test("Negative test: missing original event and missing allocations rejects", () => {
  const { id: uid } = makeUser(100);
  const attempt = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: 999999, // Non-existent
    refundRange: "1-1",
    projectId: 85011,
  });

  assert.equal(attempt.refunded, false);
  assert.equal(attempt.code, "NO_CHARGE_EVIDENCE");
  assert.equal(findUserById(uid).credits, 100);
});

test("Negative test: lost post-V2 allocations requires audit and does not convert to permanent compensation", () => {
  const { id: uid } = makeUser(100);
  // Ensure V13 migration timestamp exists in schema_migrations
  const v13Row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 13").get();
  assert.ok(v13Row?.applied_at, "V13 migration must be recorded");

  // Create a debit event created AFTER V13 applied_at, but with NO allocation rows
  const postV13Iso = new Date(Date.parse(v13Row.applied_at) + 10000).toISOString();
  const postV13Debit = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture-post-v13-debit",
    creditDelta: -60,
    creditCost: 60,
    createdAt: postV13Iso,
  });

  const { projectId: p85012, generationId: g85012 } = insertProjectFixture(uid, { projectId: 85012, chargedCredits: 60 });
  const billingId = insertBillingRequestFixture({
    userId: uid,
    projectId: p85012,
    generationId: g85012,
    creditCost: 60,
    creditEventId: postV13Debit.id,
    status: "committed",
    createdAt: postV13Iso,
  });

  const attempt = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: postV13Debit.id,
    refundRange: "1-1",
    projectId: 85012,
  });

  // Must be refused with POST_V2_MISSING_ALLOCATIONS_AUDIT
  assert.equal(attempt.refunded, false);
  assert.equal(attempt.code, "POST_V2_MISSING_ALLOCATIONS_AUDIT");
  assert.equal(attempt.auditRequired, true);

  // Must NOT create permanent compensation lot
  const compensationLots = db.prepare("SELECT COUNT(*) AS count FROM credit_lots WHERE user_id = ? AND source_type = 'compensation'").get(uid).count;
  assert.equal(compensationLots, 0);

  // Billing request status must be updated to audit_required
  const updatedBilling = db.prepare("SELECT status FROM video_project_billing_requests WHERE id = ?").get(billingId);
  assert.equal(updatedBilling.status, "audit_required");
});

test("Negative test: reserved billing request only without debit event cannot authorize refund", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  // Billing request exists but is only 'reserved' (never debited or committed)
  const { projectId: p85013, generationId: g85013 } = insertProjectFixture(uid, { projectId: 85013, chargedCredits: 60 });
  insertBillingRequestFixture({
    userId: uid,
    projectId: p85013,
    generationId: g85013,
    creditCost: 60,
    creditEventId: null,
    status: "reserved",
    createdAt: nowIso,
  });

  const attempt = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: 888123,
    refundRange: "1-1",
    projectId: 85013,
  });

  assert.equal(attempt.refunded, false);
  assert.equal(attempt.code, "NO_CHARGE_EVIDENCE");
});

test("Negative test: non-video action type cannot authorize video refund", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const nonVideoDebit = insertCreditEvent({
    userId: uid,
    actionType: "trendAnalysis",
    actionLabel: "趋势分析",
    creditDelta: -60,
    creditCost: 60,
    createdAt: nowIso,
  });

  const attempt = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: nonVideoDebit.id,
    refundRange: "1-1",
    projectId: 85016,
  });

  assert.equal(attempt.refunded, false);
  assert.equal(attempt.code, "INVALID_ORIGINAL_EVENT");
});

test("Controlled legacy path: demonstrably pre-V13 debit safely issues compensation lot", () => {
  const { id: uid } = makeUser(100);
  const v13Row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 13").get();
  // Pre-V13 timestamp
  const preV13Iso = new Date(Date.parse(v13Row.applied_at) - 86400000).toISOString();

  const legacyDebit = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "legacy-pre-v13-debit",
    creditDelta: -60,
    creditCost: 60,
    createdAt: preV13Iso,
  });

  const { projectId: p85014, generationId: g85014 } = insertProjectFixture(uid, { projectId: 85014, chargedCredits: 60 });
  const billingId = insertBillingRequestFixture({
    userId: uid,
    projectId: p85014,
    generationId: g85014,
    creditCost: 60,
    creditEventId: legacyDebit.id,
    status: "committed",
    createdAt: preV13Iso,
  });

  const refund = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: legacyDebit.id,
    refundRange: "1-1",
    projectId: 85014,
  });

  assert.equal(refund.refunded, true);
  assert.equal(refund.amount, 20);
  assert.equal(findUserById(uid).credits, 120);

  // Verify compensation lot was created
  const compLot = db.prepare("SELECT * FROM credit_lots WHERE user_id = ? AND source_type = 'compensation'").get(uid);
  assert.ok(compLot);
  assert.equal(compLot.remaining_credits, 20);
});

test("Real repository spend then refund entry point test", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";

  // Real repository spending flow via spendCreditsWithEventInTransaction
  const spendResult = spendCreditsWithEventInTransaction({
    userId: uid,
    amount: 60,
    event: {
      actionType: "videoProject",
      actionLabel: "视频生成",
      payload: { projectId: 85015 },
    },
  });

  assert.equal(spendResult.spent, true);
  assert.ok(spendResult.creditEvent.id);
  assert.equal(findUserById(uid).credits, 40);

  // Verify allocation rows exist
  const allocs = db.prepare("SELECT * FROM credit_lot_allocations WHERE credit_event_id = ?").all(spendResult.creditEvent.id);
  assert.ok(allocs.length > 0);
  assert.equal(allocs.reduce((s, a) => s + a.credits_used, 0), 60);

  // Create billing request as video project service would
  const { projectId: p85015, generationId: g85015 } = insertProjectFixture(uid, { projectId: 85015, chargedCredits: 60 });
  insertBillingRequestFixture({
    userId: uid,
    projectId: p85015,
    generationId: g85015,
    creditCost: 60,
    creditEventId: spendResult.creditEvent.id,
    status: "committed",
    createdAt: nowIso,
  });

  // Partial refund clip 3 (20 credits)
  const refund = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: spendResult.creditEvent.id,
    refundRange: "3-3",
    projectId: 85015,
  });

  assert.equal(refund.refunded, true);
  assert.equal(refund.amount, 20);
  assert.equal(findUserById(uid).credits, 60);
  assert.equal(sumVideoProjectRefundCredits({ userId: uid, projectId: 85015 }), 20);
});

test("Overlap regression below total ceiling: charge 100 five 20 clips, refund 3-4 amount 40 then 4-5 amount 40 must deny/audit, balance remains 40 restored not 80; disjoint ranges still work", () => {
  const { id: uid } = makeUser(100);
  const nowIso = "2026-01-01T00:00:00.000Z";
  const event = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture-5clips-100",
    creditDelta: -100,
    creditCost: 100,
    createdAt: nowIso,
  });
  spendCreditsFromLots({ userId: uid, amount: 100, creditEventId: event.id, nowIso }, db);
  assert.equal(findUserById(uid).credits, 0);

  const { projectId, generationId } = insertProjectFixture(uid, { projectId: 85020, chargedCredits: 100 });
  insertBillingRequestFixture({
    userId: uid,
    projectId,
    generationId,
    creditCost: 100,
    creditEventId: event.id,
    status: "committed",
    createdAt: nowIso,
  });

  // Step 1: refund clips 3-4 (40 credits) -> succeeds
  const r1 = refundVideoCredits({
    userId: uid,
    amount: 40,
    reservationCreditEventId: event.id,
    refundRange: "3-4",
    projectId: 85020,
  });
  assert.equal(r1.refunded, true);
  assert.equal(r1.amount, 40);
  assert.equal(findUserById(uid).credits, 40);

  // Step 2: refund clips 4-5 (40 credits) -> total 40 + 40 = 80 <= 100 total ceiling!
  // Overlaps at clip 4! Must deny with OVERLAPPING_REFUND_RANGE
  const r2 = refundVideoCredits({
    userId: uid,
    amount: 40,
    reservationCreditEventId: event.id,
    refundRange: "4-5",
    projectId: 85020,
  });
  assert.equal(r2.refunded, false);
  assert.equal(r2.amount, 0);
  assert.equal(r2.code, "OVERLAPPING_REFUND_RANGE");

  // Balance remains 40 restored, NOT 80!
  assert.equal(findUserById(uid).credits, 40);

  // Step 3: refund disjoint clips 1-2 (40 credits) -> disjoint ranges still work!
  const r3 = refundVideoCredits({
    userId: uid,
    amount: 40,
    reservationCreditEventId: event.id,
    refundRange: "1-2",
    projectId: 85020,
  });
  assert.equal(r3.refunded, true);
  assert.equal(r3.amount, 40);
  assert.equal(findUserById(uid).credits, 80);
});

test("Rollback trigger test for refund+expiry ledger atomicity", () => {
  const id = ++userSeq;
  const grantIso = "2026-01-01T00:00:00.000Z";
  const expiryIso = "2026-01-05T00:00:00.000Z";
  const pastExpiryMs = Date.parse("2026-01-10T00:00:00.000Z");

  insertUser({ id, name: `user-${id}`, phone: `139${String(id).padStart(8, "0")}`, password: "pwd", credits: 0, createdAt: grantIso });
  db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(id);

  insertCreditEvent({
    userId: id,
    actionType: "system_grant",
    actionLabel: "系统发放",
    creditDelta: 100,
    creditCost: 0,
    createdAt: grantIso,
  });
  const lotId = Number(createCreditLot({
    userId: id,
    sourceType: "cycle",
    sourceLabel: "monthly",
    credits: 100,
    startsAt: grantIso,
    expiresAt: expiryIso,
    nowIso: grantIso,
  }, db));

  const event = insertCreditEvent({
    userId: id,
    actionType: "videoProject",
    actionLabel: "fixture",
    creditDelta: -60,
    creditCost: 60,
    createdAt: grantIso,
  });
  spendCreditsFromLots({ userId: id, amount: 60, creditEventId: event.id, nowIso: grantIso }, db);

  setNowGetter(() => pastExpiryMs);
  try {
    rescanExpiredLots(id, pastExpiryMs, db);

    const lotBefore = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotId);
    const evtsBefore = db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = ?").get(id).c;

    const { transaction } = require("../../src/server/db/connection");
    assert.throws(() => {
      transaction(() => {
        refundVideoCredits({
          userId: id,
          amount: 20,
          reservationCreditEventId: event.id,
          refundRange: "3-3",
          projectId: 85021,
        });
        throw new Error("forced-rollback-failure");
      })();
    }, /forced-rollback-failure/);

    const lotAfter = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotId);
    assert.equal(lotAfter.used_credits, lotBefore.used_credits);
    assert.equal(lotAfter.remaining_credits, lotBefore.remaining_credits);
    assert.equal(lotAfter.status, lotBefore.status);

    const evtsAfter = db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = ?").get(id).c;
    assert.equal(evtsAfter, evtsBefore);
  } finally {
    setNowGetter(() => mockNowMs);
  }
});

test("Valid and invalid legacy date cases", () => {
  const { id: uid } = makeUser(100);
  const v13Row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 13").get();
  assert.ok(v13Row?.applied_at);

  // Case 1: Valid pre-V13 date creates compensation lot
  const preV13Iso = new Date(Date.parse(v13Row.applied_at) - 86400000).toISOString();
  const legacyDebit = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "valid-pre-v13-debit",
    creditDelta: -60,
    creditCost: 60,
    createdAt: preV13Iso,
  });
  const { projectId: p1, generationId: g1 } = insertProjectFixture(uid, { projectId: 85022, chargedCredits: 60 });
  insertBillingRequestFixture({
    userId: uid,
    projectId: p1,
    generationId: g1,
    creditCost: 60,
    creditEventId: legacyDebit.id,
    status: "committed",
    createdAt: preV13Iso,
  });
  const rValid = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: legacyDebit.id,
    refundRange: "1-1",
    projectId: p1,
  });
  assert.equal(rValid.refunded, true);
  assert.equal(rValid.amount, 20);

  // Case 2: Post-V13 date without allocations requires audit
  const postV13Iso = new Date(Date.parse(v13Row.applied_at) + 86400000).toISOString();
  const postDebit = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "post-v13-no-alloc",
    creditDelta: -60,
    creditCost: 60,
    createdAt: postV13Iso,
  });
  const { projectId: p2, generationId: g2 } = insertProjectFixture(uid, { projectId: 85023, chargedCredits: 60 });
  insertBillingRequestFixture({
    userId: uid,
    projectId: p2,
    generationId: g2,
    creditCost: 60,
    creditEventId: postDebit.id,
    status: "committed",
    createdAt: postV13Iso,
  });
  const rPost = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: postDebit.id,
    refundRange: "1-1",
    projectId: p2,
  });
  assert.equal(rPost.refunded, false);
  assert.equal(rPost.code, "POST_V2_MISSING_ALLOCATIONS_AUDIT");

  // Case 3: Invalid / malformed date string on debit event handles safely without crash
  const unparseableDebit = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "unparseable-date-debit",
    creditDelta: -60,
    creditCost: 60,
    createdAt: "invalid-date-string-xyz",
  });
  const { projectId: p3, generationId: g3 } = insertProjectFixture(uid, { projectId: 85024, chargedCredits: 60 });
  insertBillingRequestFixture({
    userId: uid,
    projectId: p3,
    generationId: g3,
    creditCost: 60,
    creditEventId: unparseableDebit.id,
    status: "committed",
    createdAt: "invalid-date-string-xyz",
  });
  const rInvalid = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: unparseableDebit.id,
    refundRange: "1-1",
    projectId: p3,
  });
  assert.equal(rInvalid.refunded, false);
  assert.equal(rInvalid.code, "POST_V2_MISSING_ALLOCATIONS_AUDIT");
});

test("Service audit message test: billing request error message is recorded upon audit trigger", () => {
  const { id: uid } = makeUser(100);
  const v13Row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 13").get();
  const postV13Iso = new Date(Date.parse(v13Row.applied_at) + 10000).toISOString();
  const postV13Debit = insertCreditEvent({
    userId: uid,
    actionType: "videoProject",
    actionLabel: "fixture-audit-msg",
    creditDelta: -60,
    creditCost: 60,
    createdAt: postV13Iso,
  });

  const { projectId, generationId } = insertProjectFixture(uid, { projectId: 85025, chargedCredits: 60 });
  const billingId = insertBillingRequestFixture({
    userId: uid,
    projectId,
    generationId,
    creditCost: 60,
    creditEventId: postV13Debit.id,
    status: "committed",
    createdAt: postV13Iso,
  });

  const attempt = refundVideoCredits({
    userId: uid,
    amount: 20,
    reservationCreditEventId: postV13Debit.id,
    refundRange: "1-1",
    projectId: 85025,
  });

  assert.equal(attempt.refunded, false);
  assert.equal(attempt.code, "POST_V2_MISSING_ALLOCATIONS_AUDIT");
  assert.equal(attempt.auditRequired, true);

  // Verify billing request error message is recorded and status is audit_required
  const row = db.prepare("SELECT status, error FROM video_project_billing_requests WHERE id = ?").get(billingId);
  assert.equal(row.status, "audit_required");
  assert.match(row.error, /Reservation missing lot allocations requires audit/);
});
