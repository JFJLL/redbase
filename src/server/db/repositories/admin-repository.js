const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");
const { findUserById, updateUserCredits } = require("./auth-repository");
const { mapCreditEventRow } = require("./row-mappers");

const db = getDbProxy();

function insertCreditEvent(input) {
  const id = input.id ?? allocateCounter("nextCreditEventId", 1);
  db.prepare(`
    INSERT INTO credit_events (
      id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
      admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title,
      generation_id, channel_label, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    Number(input.userId),
    input.actionType,
    input.actionLabel,
    Number(input.creditDelta || 0),
    Number(input.creditCost || 0),
    input.createdAt || new Date().toISOString(),
    input.adminUserId ?? null,
    input.adminUserName || "",
    input.brandId ?? null,
    input.brandName || "",
    input.trendId ?? null,
    input.trendTitle || "",
    input.ideaTitle || "",
    input.generationId ?? null,
    input.channelLabel || "",
    input.summary || "",
    JSON.stringify(input.payload || {}),
  );
  return mapCreditEventRow(db.prepare("SELECT * FROM credit_events WHERE id = ?").get(id));
}

function findCreditEventById(creditEventId) {
  return mapCreditEventRow(db.prepare("SELECT * FROM credit_events WHERE id = ?").get(Number(creditEventId)));
}

function findGenerationForCreditEvent(creditEventId, userId) {
  return db.prepare(`
    SELECT generation_id AS generationId
    FROM credit_events
    WHERE id = ? AND user_id = ? AND generation_id IS NOT NULL
  `).get(Number(creditEventId), Number(userId))?.generationId ?? null;
}

function updateCreditEventGeneration(creditEventId, generation, generationPayload) {
  const event = findCreditEventById(creditEventId);
  if (!event) return null;
  const payload = {
    ...(event.payload || {}),
    generationPayload: generationPayload || generation?.payload || {},
  };
  db.prepare(`
    UPDATE credit_events
    SET generation_id = ?,
        channel_label = ?,
        summary = ?,
        payload_json = ?
    WHERE id = ?
  `).run(
    generation.id,
    generation.channelLabel || event.channelLabel,
    generation.summary || generation.cardTitle || event.summary,
    JSON.stringify(payload),
    Number(creditEventId),
  );
  return findCreditEventById(creditEventId);
}

function updateCreditEventEditResult(creditEventId, editEntry, sourceGenerationId) {
  const event = findCreditEventById(creditEventId);
  if (!event) return null;
  db.prepare(`
    UPDATE credit_events
    SET generation_id = ?,
        payload_json = ?
    WHERE id = ?
  `).run(
    Number(sourceGenerationId) || event.generationId,
    JSON.stringify({
      ...(event.payload || {}),
      editResult: editEntry,
    }),
    Number(creditEventId),
  );
  return findCreditEventById(creditEventId);
}

function attachGenerationToLatestCreditEvent({ user, actionType, brand, trend, idea, generation, generationPayload }) {
  const event = db.prepare(`
    SELECT *
    FROM credit_events
    WHERE user_id = ?
      AND action_type = ?
      AND generation_id IS NULL
      AND brand_id = ?
      AND trend_id = ?
      AND (idea_title = '' OR idea_title = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(user.id, actionType, brand.id, trend.id, idea.title);
  if (!event) return null;
  return updateCreditEventGeneration(event.id, generation, generationPayload);
}

function addCredits({ targetUserId, amount, adminUser, note }) {
  return runTransaction(() => {
    const targetUser = findUserById(targetUserId);
    if (!targetUser) return null;
    const nextCredits = Number(targetUser.credits || 0) + Number(amount || 0);
    updateUserCredits(targetUser.id, nextCredits);
    const updatedUser = findUserById(targetUser.id);
    insertCreditEvent({
      userId: targetUser.id,
      actionType: "adminAddCredits",
      actionLabel: "管理员加额度",
      creditDelta: amount,
      creditCost: 0,
      adminUserId: adminUser.id,
      adminUserName: adminUser.name,
      summary: String(note || "").trim() || `管理员为用户增加 ${amount} 额度`,
      payload: { note: String(note || "").trim() },
    });
    return updatedUser;
  });
}

function deleteUserCascadeRows(userId) {
  return runTransaction(() => {
    const user = findUserById(userId);
    if (!user) return null;
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM verification_codes WHERE phone = ?").run(user.phone);
    db.prepare("DELETE FROM credit_events WHERE user_id = ? OR admin_user_id = ?").run(user.id, user.id);
    db.prepare("DELETE FROM image_jobs WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM product_images WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM generations WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM ideas WHERE trend_row_id IN (SELECT row_id FROM trends WHERE brand_id IN (SELECT id FROM brands WHERE owner_user_id = ?))").run(user.id);
    db.prepare("DELETE FROM trends WHERE brand_id IN (SELECT id FROM brands WHERE owner_user_id = ?)").run(user.id);
    db.prepare("DELETE FROM analyses WHERE brand_id IN (SELECT id FROM brands WHERE owner_user_id = ?)").run(user.id);
    db.prepare("DELETE FROM brands WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    return user;
  });
}

module.exports = {
  insertCreditEvent,
  findCreditEventById,
  findGenerationForCreditEvent,
  updateCreditEventGeneration,
  updateCreditEventEditResult,
  attachGenerationToLatestCreditEvent,
  addCredits,
  deleteUserCascadeRows,
};
