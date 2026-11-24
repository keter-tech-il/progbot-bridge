"use strict";
/*
  חשבונות (פרופילים): עסקי, אישי וכו'. כל חשבון: { id, label, username, email, authTokenEnv, sessionCookieEnv, csrfEnv, default }
  הסודות עצמם (טוקן / עוגייה) רק במשתני סביבה – בקובץ נשמר רק *השם* של המשתנה.
  מקור: ACCOUNTS (JSON במשתנה סביבה), או קובץ BRIDGE_ACCOUNTS_FILE (ברירת מחדל accounts.json ליד השרת),
  ואם אין – חשבון אחד מ־FORUM_USERNAME / ACCOUNT_EMAIL / AUTH_TOKEN / SESSION_COOKIE.
*/
const fs = require("fs");
const path = require("path");

function loadAccounts(env = process.env, dir = __dirname) {
  let list = null;
  if (env.ACCOUNTS) {
    try {
      list = JSON.parse(env.ACCOUNTS);
    } catch (e) {
      throw new Error("ACCOUNTS אינו JSON תקין: " + e.message);
    }
  } else {
    const file = env.BRIDGE_ACCOUNTS_FILE || path.join(dir, "..", "accounts.json");
    if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (!Array.isArray(list) || !list.length) {
    list = [{ id: "business", label: "עסקי", username: env.FORUM_USERNAME || "בונה מערכות", email: env.ACCOUNT_EMAIL || "", authTokenEnv: "AUTH_TOKEN", sessionCookieEnv: "SESSION_COOKIE", default: true }];
  }
  const seen = new Set();
  const accounts = list.map((a, i) => {
    const id = String(a.id || "").trim();
    if (!/^[\w-]{1,40}$/.test(id)) throw new Error(`חשבון ${i + 1}: id חסר או לא תקין (אותיות באנגלית, ספרות, - _).`);
    if (seen.has(id)) throw new Error("חשבון כפול: " + id);
    seen.add(id);
    if (!a.username) throw new Error(`חשבון ${id}: חסר username (שם המשתמש בפורום).`);
    return {
      id,
      label: String(a.label || id),
      username: String(a.username),
      email: String(a.email || ""),
      authTokenEnv: a.authTokenEnv || (i === 0 ? "AUTH_TOKEN" : `AUTH_TOKEN_${id.toUpperCase()}`),
      sessionCookieEnv: a.sessionCookieEnv || (i === 0 ? "SESSION_COOKIE" : `SESSION_COOKIE_${id.toUpperCase()}`),
      csrfEnv: a.csrfEnv || null,
      default: Boolean(a.default),
    };
  });
  if (!accounts.some((a) => a.default)) accounts[0].default = true;
  return accounts;
}

/* מה שמותר להראות לאפליקציה (בלי שמות משתני הסודות ובלי סודות) */
function publicAccount(a, env = process.env) {
  return {
    id: a.id,
    label: a.label,
    username: a.username,
    email: a.email,
    default: a.default,
    hasAuth: Boolean(env[a.authTokenEnv] || env[a.sessionCookieEnv]),
  };
}

module.exports = { loadAccounts, publicAccount };
