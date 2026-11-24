"use strict";
/*
  שגיאה אחידה מהמתאם. הגשר מתרגם אותה לקוד HTTP לפי החוזה של האפליקציה:
    retryable=true  → 503 (או 429 עם Retry-After) – האפליקציה תנסה שוב
    retryable=false → 4xx – כישלון קבוע, האפליקציה לא תנסה שוב ותשלח לך מייל
  code: session_expired | rate_limited | not_found | invalid | forbidden | network | upstream
*/
class AdapterError extends Error {
  constructor(message, { status = 502, retryable = false, code = "upstream", retryAfterSec = null } = {}) {
    super(message);
    this.name = "AdapterError";
    this.status = status;
    this.retryable = retryable;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

/* תרגום תשובת HTTP מהפורום לשגיאה אחידה */
function fromHttp(status, bodyText, retryAfter) {
  const msg = (() => {
    try {
      const j = JSON.parse(bodyText || "{}");
      return j.error || j.message || "";
    } catch {
      return String(bodyText || "").slice(0, 200);
    }
  })();
  if (status === 401 || status === 403) return new AdapterError("הסשן בפורום פג או לא תקין – צריך לחדש SESSION_COOKIE / AUTH_TOKEN. " + msg, { status: 403, code: "session_expired" });
  if (status === 429) return new AdapterError("הפורום מגביל קצב. " + msg, { status: 429, retryable: true, code: "rate_limited", retryAfterSec: Number(retryAfter) || 120 });
  if (status === 404) return new AdapterError("לא נמצא בפורום (שרשור/הודעה נמחקו?). " + msg, { status: 404, code: "not_found" });
  if (status >= 500) return new AdapterError(`הפורום החזיר ${status}. ` + msg, { status: 503, retryable: true, code: "upstream" });
  return new AdapterError(`הפורום דחה את הבקשה (${status}). ` + msg, { status: 422, code: "invalid" });
}

module.exports = { AdapterError, fromHttp };
