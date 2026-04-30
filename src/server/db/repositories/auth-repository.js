const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");
const { mapUserRow, mapSessionRow } = require("./row-mappers");

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
  createUserWithSession,
  createSessionForUser,
};
