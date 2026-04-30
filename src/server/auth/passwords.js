const crypto = require("crypto");
const util = require("util");

const scrypt = util.promisify(crypto.scrypt);
const PASSWORD_SCHEME = "scrypt";
const PASSWORD_VERSION = "v1";
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};
const KEY_LENGTH = 64;

function encodePasswordHash({ salt, derivedKey }) {
  return [
    PASSWORD_SCHEME,
    PASSWORD_VERSION,
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

function parsePasswordHash(value) {
  const parts = String(value || "").split("$");
  if (parts.length !== 7 || parts[0] !== PASSWORD_SCHEME || parts[1] !== PASSWORD_VERSION) return null;
  const [scheme, version, n, r, p, salt, hash] = parts;
  const options = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_OPTIONS.maxmem,
  };
  if (!Number.isFinite(options.N) || !Number.isFinite(options.r) || !Number.isFinite(options.p)) return null;
  return {
    scheme,
    version,
    options,
    salt: Buffer.from(salt, "base64url"),
    derivedKey: Buffer.from(hash, "base64url"),
  };
}

function isPasswordHash(value) {
  return Boolean(parsePasswordHash(value));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(String(password || ""), salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return encodePasswordHash({ salt, derivedKey });
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(String(password || ""), salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return encodePasswordHash({ salt, derivedKey });
}

async function verifyPassword(password, storedPassword) {
  const parsed = parsePasswordHash(storedPassword);
  if (!parsed) {
    return String(password || "") === String(storedPassword || "");
  }
  const derivedKey = await scrypt(String(password || ""), parsed.salt, parsed.derivedKey.length, parsed.options);
  if (derivedKey.length !== parsed.derivedKey.length) return false;
  return crypto.timingSafeEqual(derivedKey, parsed.derivedKey);
}

async function verifyAndMigratePassword(user, password) {
  if (!user) return { ok: false, migrated: false };
  const ok = await verifyPassword(password, user.password);
  if (!ok) return { ok: false, migrated: false };
  if (isPasswordHash(user.password)) return { ok: true, migrated: false };
  user.password = await hashPassword(password);
  return { ok: true, migrated: true };
}

module.exports = {
  hashPassword,
  hashPasswordSync,
  isPasswordHash,
  verifyPassword,
  verifyAndMigratePassword,
};
