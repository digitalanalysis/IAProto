const crypto = require("crypto");

const SESSION_COOKIE_NAME = "cdv_session";
const SESSION_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCKOUT_MS = 60 * 1000;
const SCRYPT_KEY_LENGTH = 64;

const sessions = new Map();
const loginFailures = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  const [scheme, saltHex, hashHex] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_IDLE_TIMEOUT_MS });
  return token;
}

function getSessionUsername(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (!token) {
    return "";
  }
  const session = sessions.get(token);
  if (!session) {
    return "";
  }
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return "";
  }
  session.expiresAt = Date.now() + SESSION_IDLE_TIMEOUT_MS;
  return session.username;
}

function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (token) {
    sessions.delete(token);
  }
}

function destroySessionsForUser(username) {
  for (const [token, session] of sessions) {
    if (session.username === username) {
      sessions.delete(token);
    }
  }
}

// Cookies set over HTTPS are marked Secure so the browser never sends them over plain HTTP.
function cookieAttributes(req) {
  return `Path=/; HttpOnly; SameSite=Lax${req.secure ? "; Secure" : ""}`;
}

function setSessionCookie(req, res, token) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(req)}`);
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; ${cookieAttributes(req)}; Max-Age=0`);
}

function getLoginFailureKey(req, username) {
  return `${req.ip || ""}|${username}`;
}

function isLoginLocked(req, username) {
  const entry = loginFailures.get(getLoginFailureKey(req, username));
  return Boolean(entry && entry.count >= LOGIN_FAILURE_LIMIT && entry.lockedUntil > Date.now());
}

function recordLoginFailure(req, username) {
  const key = getLoginFailureKey(req, username);
  const entry = loginFailures.get(key);
  const count = entry && entry.lockedUntil > Date.now() ? entry.count + 1 : 1;
  loginFailures.set(key, { count, lockedUntil: Date.now() + LOGIN_LOCKOUT_MS });
}

function clearLoginFailures(req, username) {
  loginFailures.delete(getLoginFailureKey(req, username));
}

// Only allow redirects back into this app after login.
function sanitizeNextPath(value) {
  const next = String(value || "");
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}

module.exports = {
  hashPassword,
  verifyPassword,
  normalizeUsername,
  createSession,
  getSessionUsername,
  destroySession,
  destroySessionsForUser,
  setSessionCookie,
  clearSessionCookie,
  isLoginLocked,
  recordLoginFailure,
  clearLoginFailures,
  sanitizeNextPath
};
