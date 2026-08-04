const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");
const { mapUserRow, mapSessionRow } = require("./row-mappers");
const crypto = require("crypto");

const db = getDbProxy();

const USER_COLUMNS = "id, name, phone, password, account_type, department, credits, created_at";

function findUserById(userId) {
  return mapUserRow(db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(Number(userId)));
}

function findUserByPhone(phone) {
  return mapUserRow(db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE phone = ?`).get(String(phone || "")));
}

function phoneExists(phone) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE phone = ?").get(String(phone || "")));
}

function insertUser(input) {
  db.prepare(`
    INSERT INTO users (id, name, phone, password, account_type, department, credits, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.phone,
    input.password,
    input.accountType || "customer",
    input.department || "",
    Number(input.credits || 0),
    input.createdAt,
  );
  return findUserById(input.id);
}

function updateUserPassword(userId, password) {
  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(String(password || ""), Number(userId));
}

function updateUserCredits(userId, credits) {
  db.prepare("UPDATE users SET credits = ? WHERE id = ?").run(Number(credits || 0), Number(userId));
}

function findSessionByToken(token) {
  return mapSessionRow(db.prepare("SELECT token, user_id, created_at FROM sessions WHERE token = ?").get(String(token || "")));
}

function findUserBySessionToken(token) {
  const session = findSessionByToken(token);
  if (!session) return null;
  return findUserById(session.userId);
}

function insertSession(session) {
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    session.token,
    Number(session.userId),
    session.createdAt,
  );
  return session;
}

function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(String(token || ""));
}

function upsertVerificationCode(phone, code, expiresAt) {
  db.prepare(`
    INSERT INTO verification_codes (phone, code, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at
  `).run(String(phone || ""), String(code || ""), Number(expiresAt || 0));
}

function deleteVerificationCode(phone) {
  db.prepare("DELETE FROM verification_codes WHERE phone = ?").run(String(phone || ""));
}

function findVerificationChallenge(purpose, phone) {
  return db.prepare(`
    SELECT id, purpose, phone, code_hmac, expires_at_ms, attempts, sent_count,
           last_sent_at_ms, created_at_ms, consumed_at_ms
    FROM sms_verification_challenges
    WHERE purpose = ? AND phone = ?
  `).get(String(purpose || ""), String(phone || ""));
}

function upsertVerificationChallenge({ purpose, phone, codeHmac, expiresAtMs, nowMs }) {
  const existing = findVerificationChallenge(purpose, phone);
  const sentCount = existing ? Number(existing.sent_count || 0) + 1 : 1;
  db.prepare(`
    INSERT INTO sms_verification_challenges (
      purpose, phone, code_hmac, expires_at_ms, attempts, sent_count, last_sent_at_ms, created_at_ms, consumed_at_ms
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)
    ON CONFLICT(purpose, phone) DO UPDATE SET
      code_hmac = excluded.code_hmac,
      expires_at_ms = excluded.expires_at_ms,
      attempts = 0,
      sent_count = excluded.sent_count,
      last_sent_at_ms = excluded.last_sent_at_ms,
      consumed_at_ms = NULL
  `).run(
    String(purpose || ""),
    String(phone || ""),
    String(codeHmac || ""),
    Number(expiresAtMs || 0),
    sentCount,
    Number(nowMs || Date.now()),
    Number(nowMs || Date.now()),
  );
}

function deleteVerificationChallenge(purpose, phone) {
  db.prepare("DELETE FROM sms_verification_challenges WHERE purpose = ? AND phone = ?")
    .run(String(purpose || ""), String(phone || ""));
}

function consumeVerificationChallengeIfValid({ purpose, phone, codeHmac, nowMs, maxAttempts }) {
  const row = findVerificationChallenge(purpose, phone);
  if (!row) return false;
  if (row.consumed_at_ms !== null && Number(row.consumed_at_ms) > 0) return false;
  if (Number(row.expires_at_ms) < Number(nowMs || Date.now())) {
    deleteVerificationChallenge(purpose, phone);
    return false;
  }
  if (Number(row.attempts || 0) >= Number(maxAttempts || 5)) {
    deleteVerificationChallenge(purpose, phone);
    return false;
  }
  const stored = Buffer.from(String(row.code_hmac || ""), "base64");
  const candidate = Buffer.from(String(codeHmac || ""), "base64");
  if (stored.length === 0 || stored.length !== candidate.length || !crypto.timingSafeEqual(stored, candidate)) {
    db.prepare(`
      UPDATE sms_verification_challenges
      SET attempts = attempts + 1
      WHERE purpose = ? AND phone = ?
    `).run(String(purpose || ""), String(phone || ""));
    return false;
  }
  const result = db.prepare(`
    UPDATE sms_verification_challenges
    SET consumed_at_ms = ?
    WHERE purpose = ? AND phone = ? AND consumed_at_ms IS NULL
  `).run(Number(nowMs || Date.now()), String(purpose || ""), String(phone || ""));
  return result.changes > 0;
}

function incrementSmsRateLimit(scope, bucketKey, windowStartMs, limit) {
  const row = db.prepare(`
    SELECT count FROM sms_send_rate_limits
    WHERE scope = ? AND bucket_key = ? AND window_start_ms = ?
  `).get(String(scope || ""), String(bucketKey || ""), Number(windowStartMs || 0));
  if (!row) {
    try {
      db.prepare(`
        INSERT INTO sms_send_rate_limits (scope, bucket_key, window_start_ms, count)
        VALUES (?, ?, ?, 1)
      `).run(String(scope || ""), String(bucketKey || ""), Number(windowStartMs || 0));
      return true;
    } catch (error) {
      if (!String(error?.code || "").includes("SQLITE_CONSTRAINT")) throw error;
    }
  }
  const current = row ? Number(row.count || 0) : 0;
  if (current >= Number(limit || 0)) return false;
  const result = db.prepare(`
    UPDATE sms_send_rate_limits
    SET count = count + 1
    WHERE scope = ? AND bucket_key = ? AND window_start_ms = ?
  `).run(String(scope || ""), String(bucketKey || ""), Number(windowStartMs || 0));
  return result.changes > 0;
}

function deleteSessionsForUser(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(Number(userId));
}

function createUserWithSession({ user, token }) {
  return runTransaction(() => {
    const userId = allocateCounter("nextUserId", 1);
    const insertedUser = insertUser({ ...user, id: userId });
    deleteVerificationCode(user.phone);
    insertSession({
      token,
      userId,
      createdAt: new Date().toISOString(),
    });
    return insertedUser;
  });
}

function registerUserWithVerification({ user, token, purpose, phone, codeHmac, nowMs, maxAttempts }) {
  return runTransaction(() => {
    const consumed = consumeVerificationChallengeIfValid({
      purpose,
      phone,
      codeHmac,
      nowMs,
      maxAttempts,
    });
    if (!consumed) {
      throw Object.assign(new Error("验证码错误或已过期"), { code: "VERIFICATION_INVALID" });
    }
    const userId = allocateCounter("nextUserId", 1);
    const insertedUser = insertUser({ ...user, id: userId });
    deleteVerificationCode(user.phone);
    insertSession({
      token,
      userId,
      createdAt: new Date().toISOString(),
    });
    return insertedUser;
  });
}

function resetPasswordWithVerification({ phone, codeHmac, passwordHash, nowMs, maxAttempts }) {
  return runTransaction(() => {
    const consumed = consumeVerificationChallengeIfValid({
      purpose: "reset_password",
      phone,
      codeHmac,
      nowMs,
      maxAttempts,
    });
    if (!consumed) {
      throw Object.assign(new Error("验证码错误或已过期"), { code: "VERIFICATION_INVALID" });
    }
    const user = findUserByPhone(phone);
    if (!user) return { ok: true, userId: null };
    updateUserPassword(user.id, passwordHash);
    deleteSessionsForUser(user.id);
    return { ok: true, userId: user.id };
  });
}

function createSessionForUser(userId, token) {
  return runTransaction(() => {
    insertSession({
      token,
      userId,
      createdAt: new Date().toISOString(),
    });
    return findUserById(userId);
  });
}

function migrateUserPhoneWithSession(userId, phone, token) {
  return runTransaction(() => {
    db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(String(phone || ""), Number(userId));
    insertSession({
      token,
      userId,
      createdAt: new Date().toISOString(),
    });
    return findUserById(userId);
  });
}

module.exports = {
  findUserById,
  findUserByPhone,
  phoneExists,
  insertUser,
  updateUserPassword,
  updateUserCredits,
  findSessionByToken,
  findUserBySessionToken,
  insertSession,
  deleteSession,
  upsertVerificationCode,
  deleteVerificationCode,
  findVerificationChallenge,
  upsertVerificationChallenge,
  deleteVerificationChallenge,
  consumeVerificationChallengeIfValid,
  incrementSmsRateLimit,
  deleteSessionsForUser,
  createUserWithSession,
  registerUserWithVerification,
  resetPasswordWithVerification,
  createSessionForUser,
  migrateUserPhoneWithSession,
};
