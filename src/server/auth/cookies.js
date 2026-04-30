const SESSION_COOKIE_NAME = "redbase_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function parseCookies(req) {
  const header = String(req?.headers?.cookie || "");
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (error) {
      cookies[key] = value;
    }
  }
  return cookies;
}

function getCookieSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE_NAME] || "";
}

function appendSetCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
    return;
  }
  const values = Array.isArray(existing) ? existing : [existing];
  res.setHeader("Set-Cookie", [...values, value]);
}

function setSessionCookie(res, token) {
  const encoded = encodeURIComponent(String(token || ""));
  appendSetCookie(
    res,
    `${SESSION_COOKIE_NAME}=${encoded}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  );
}

function clearSessionCookie(res) {
  appendSetCookie(res, `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  SESSION_COOKIE_NAME,
  getCookieSessionToken,
  setSessionCookie,
  clearSessionCookie,
};
