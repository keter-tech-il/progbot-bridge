"use strict";
/*
  המתאם (Adapter) – השכבה היחידה שמדברת עם הפורום. הליבה והגשר לא יודעים איזה פורום זה.
  להחליף פורום = להחליף מתאם (ADAPTER=...), בלי לגעת בשאר הקוד.

  ממשק כל מתאם:
    fetchNew(account, { since, limit })  → [ Post ]   הודעות חדשות שאחרים כתבו, עם הקשר השרשור
    reply(account, { threadId, postId, text, quote })  → { postId, url }
                                                    postId = ההודעה שעונים לה (מענה להודעה ספציפית),
                                                    quote = { postId, author, excerpt } או null – להציג אותה כציטוט
    like(account, { postId, threadId })             → { ok: true }
    openThread(account, { forum, title, body })     → { threadId, postId, url }
    checkSession(account)                           → { ok, username }
    fetchThread(account, threadId)                  → { thread: { id, title, forum, url }, posts: [{ id, author, text, createdAt, replyToPostId, quote }] }
                                                    (לתצוגת השיח המלא באפליקציה; לא חובה – בלעדיו האפליקציה מציגה את ההקשר שנשמר)
    search(account, { from, to, q, author, mine })  → [{ id, threadId, author, text, createdAt, url }]
                                                    (לחיפוש בצ'אט האישי: "ההודעה שהגבתי היום בשעה 2"; לא חובה)
  Post = { id, threadId, threadTitle, forum, url, author, text, createdAt,
           replyToAuthor, quotedAuthors: [], threadPosts: [{ id, author, createdAt, replyToAuthor, quotedAuthors }] }
           (או, אם הפורום נותן מספרים מוכנים: threadReplies, participants, directReply, interveningReplies)
  שגיאות: AdapterError (src/errors.js).

  מתאמים מובנים:
    memory – פורום מדומה בזיכרון (בדיקות, הדגמה, פיתוח).
    rest   – כל פורום עם API של JSON. כתובות ניתנות להגדרה, הזדהות לכל חשבון:
             AUTH_TOKEN (Authorization: Bearer) ו/או SESSION_COOKIE (Cookie), כולל ניהול עוגיות שהשרת מחדש.
*/

const crypto = require("crypto");
const { AdapterError, fromHttp } = require("./errors");

/* ---------------- פורום מדומה בזיכרון ---------------- */

class MemoryAdapter {
  constructor() {
    this.name = "memory";
    this.threads = new Map();
    this.likes = [];
    this.seq = 1000;
    this.failures = []; /* לבדיקות: [{ op, status, code, times }] */
    this.sessions = new Set(); /* חשבונות שהסשן שלהם "פג" */
  }

  nextId(prefix) {
    return prefix + ++this.seq;
  }

  /* ---- כלים להדגמה ולבדיקות ---- */
  seedThread({ id, forum = "מחשבים וטכנולוגיה", title, author, text, at, postId = null }) {
    const threadId = id || this.nextId("t");
    const t = { id: threadId, forum, title: title || text.slice(0, 40), posts: [] };
    this.threads.set(threadId, t);
    this.addPost({ threadId, author, text, at, id: postId });
    return t;
  }

  addPost({ threadId, author, text, replyToAuthor = null, quotedAuthors = [], at = null, by = null, replyToPostId = null, quote = null, id = null }) {
    const t = this.threads.get(String(threadId));
    if (!t) throw new AdapterError("השרשור לא קיים.", { status: 404, code: "not_found" });
    const p = {
      id: id || this.nextId("p"),
      threadId: t.id,
      author,
      text,
      replyToAuthor,
      quotedAuthors,
      replyToPostId,
      quote,
      createdAt: at || new Date((this.now ? this.now().getTime() : Date.now()) + this.seq).toISOString(),
      by,
    };
    t.posts.push(p);
    return p;
  }

  failNext(op, status, code, times = 1, retryAfterSec = null) {
    this.failures.push({ op, status, code, times, retryAfterSec });
  }

  maybeFail(op, account) {
    if (this.sessions.has(account.id)) throw new AdapterError("הסשן בפורום פג – צריך לחדש SESSION_COOKIE / AUTH_TOKEN.", { status: 403, code: "session_expired" });
    const f = this.failures.find((x) => (x.op === op || x.op === "*") && x.times > 0);
    if (!f) return;
    f.times--;
    if (f.code === "session_expired") throw new AdapterError("הסשן בפורום פג.", { status: 403, code: "session_expired" });
    throw fromHttp(f.status, JSON.stringify({ error: "simulated " + f.status }), f.retryAfterSec);
  }

  snapshot() {
    return { threads: [...this.threads.values()], likes: this.likes };
  }

  /* ---- הממשק ---- */
  async fetchNew(account, { since = null, limit = 50 } = {}) {
    this.maybeFail("fetch", account);
    const out = [];
    for (const t of this.threads.values()) {
      for (const p of t.posts) {
        if (p.author === account.username) continue;
        if (since && p.createdAt <= since) continue;
        const idx = t.posts.indexOf(p);
        out.push({
          id: p.id,
          threadId: t.id,
          threadTitle: t.title,
          forum: t.forum,
          url: `https://forum.test/threads/${t.id}/#${p.id}`,
          author: p.author,
          text: p.text,
          createdAt: p.createdAt,
          replyToAuthor: p.replyToAuthor,
          quotedAuthors: p.quotedAuthors,
          threadPosts: t.posts.map((x) => ({ id: x.id, author: x.author, text: x.text, createdAt: x.createdAt, replyToAuthor: x.replyToAuthor, quotedAuthors: x.quotedAuthors })),
        });
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return out.slice(0, limit);
  }

  async reply(account, { threadId, postId, text, quote = null }) {
    this.maybeFail("reply", account);
    const target = postId ? [...this.threads.values()].flatMap((t) => t.posts).find((p) => p.id === postId) : null;
    if (postId && !target) throw new AdapterError("ההודעה שעונים לה לא קיימת.", { status: 404, code: "not_found" });
    /* מענה להודעה הספציפית; עם ציטוט – ההודעה מוצגת בראש התגובה (כמו "ציטוט" בפורום) */
    const q = quote && target ? { postId: target.id, author: target.author, excerpt: String(quote.excerpt || target.text || "").slice(0, 160) } : null;
    const p = this.addPost({ threadId, author: account.username, text, replyToAuthor: target ? target.author : null, quotedAuthors: q ? [target.author] : [], by: account.id, replyToPostId: target ? target.id : null, quote: q });
    return { postId: p.id, url: `https://forum.test/threads/${threadId}/#${p.id}` };
  }

  async like(account, { postId }) {
    this.maybeFail("like", account);
    const exists = [...this.threads.values()].some((t) => t.posts.some((p) => p.id === postId));
    if (!exists) throw new AdapterError("ההודעה לא קיימת.", { status: 404, code: "not_found" });
    if (!this.likes.some((l) => l.postId === postId && l.account === account.id)) this.likes.push({ postId, account: account.id, by: account.username });
    return { ok: true };
  }

  async openThread(account, { forum, title, body }) {
    this.maybeFail("thread", account);
    const t = this.seedThread({ forum, title, author: account.username, text: body });
    t.posts[0].by = account.id;
    return { threadId: t.id, postId: t.posts[0].id, url: `https://forum.test/threads/${t.id}/` };
  }

  async checkSession(account) {
    if (this.sessions.has(account.id)) return { ok: false, error: "הסשן פג.", code: "session_expired" };
    return { ok: true, username: account.username };
  }

  async search(account, { from = null, to = null, q = "", author = null, mine = false } = {}) {
    this.maybeFail("fetch", account);
    const words = String(q || "").split(/\s+/).filter(Boolean);
    const out = [];
    for (const t of this.threads.values()) {
      for (const p of t.posts) {
        if (from && p.createdAt < from) continue;
        if (to && p.createdAt >= to) continue;
        if (mine && p.author !== account.username) continue;
        const hay = `${p.text} ${p.author} ${t.title}`;
        if (!words.every((w) => hay.includes(w))) continue;
        if (author && !(p.author === author || (p.replyToAuthor === author) || hay.includes(author))) continue;
        out.push({ id: p.id, threadId: t.id, author: p.author, text: p.text, createdAt: p.createdAt, url: `https://forum.test/threads/${t.id}/#${p.id}` });
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 50);
  }

  async fetchThread(account, threadId) {
    this.maybeFail("fetch", account);
    const t = this.threads.get(String(threadId));
    if (!t) throw new AdapterError("השרשור לא קיים.", { status: 404, code: "not_found" });
    return {
      thread: { id: t.id, title: t.title, forum: t.forum, url: `https://forum.test/threads/${t.id}/` },
      posts: t.posts.map((p) => ({ id: p.id, author: p.author, text: p.text, createdAt: p.createdAt, replyToPostId: p.replyToPostId || null, quote: p.quote || null })),
    };
  }
}

/* ---------------- כל פורום עם API של JSON ---------------- */

/*
  הגדרות (משתני סביבה):
    FORUM_API_BASE        כתובת הבסיס של ה־API של הפורום, למשל https://forum.example/api
    FORUM_EP_NEW          GET הודעות חדשות        (ברירת מחדל /posts/new?since={since}&limit={limit})
    FORUM_EP_REPLY        POST תגובה בשרשור        (ברירת מחדל /threads/{threadId}/replies)   גוף: { text, replyToPostId, quote }
    FORUM_EP_LIKE         POST לייק                (ברירת מחדל /posts/{postId}/like)
    FORUM_EP_THREAD       POST שרשור חדש           (ברירת מחדל /forums/{forum}/threads)       גוף: { title, body }
    FORUM_EP_ME           GET בדיקת סשן            (ברירת מחדל /me)
    FORUM_EP_POSTS        GET כל ההודעות בשרשור    (ברירת מחדל /threads/{threadId}/posts)     לתצוגת השיח המלא
    FORUM_EP_SEARCH       GET חיפוש הודעות         (ברירת מחדל /search?q={q}&author={author}&from={from}&to={to})
    FORUM_EXTRA_HEADERS   JSON של כותרות נוספות לכל בקשה (לא חובה)
    FORUM_TIMEOUT_MS      ברירת מחדל 15000
  הזדהות – לכל חשבון (accounts):
    authTokenEnv      שם משתנה הסביבה עם הטוקן (ברירת מחדל AUTH_TOKEN)      → Authorization: Bearer <token>
    sessionCookieEnv  שם משתנה הסביבה עם העוגייה (ברירת מחדל SESSION_COOKIE) → Cookie: <cookie>
    csrfEnv           לא חובה: שם משתנה עם טוקן CSRF                         → X-CSRF-Token
  עוגיות שהשרת מחזיר (Set-Cookie) נשמרות ומתעדכנות לכל חשבון (ניהול סשן).
*/
class RestAdapter {
  constructor(env = process.env, deps = {}) {
    this.name = "rest";
    this.env = env;
    this.fetch = deps.fetch || fetch;
    this.base = String(env.FORUM_API_BASE || "").replace(/\/+$/, "");
    if (!this.base) throw new Error("ADAPTER=rest דורש FORUM_API_BASE.");
    this.ep = {
      fetchNew: env.FORUM_EP_NEW || "/posts/new?since={since}&limit={limit}",
      reply: env.FORUM_EP_REPLY || "/threads/{threadId}/replies",
      like: env.FORUM_EP_LIKE || "/posts/{postId}/like",
      thread: env.FORUM_EP_THREAD || "/forums/{forum}/threads",
      me: env.FORUM_EP_ME || "/me",
      posts: env.FORUM_EP_POSTS || "/threads/{threadId}/posts",
      search: env.FORUM_EP_SEARCH || "/search?q={q}&author={author}&from={from}&to={to}",
    };
    this.extra = (() => {
      try {
        return env.FORUM_EXTRA_HEADERS ? JSON.parse(env.FORUM_EXTRA_HEADERS) : {};
      } catch {
        return {};
      }
    })();
    this.timeoutMs = Number(env.FORUM_TIMEOUT_MS) || 15000;
    this.cookies = new Map(); /* accountId → { name: value } – עוגיות שהשרת עדכן */
  }

  url(tpl, vars) {
    return this.base + tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] == null ? "" : vars[k]));
  }

  cookieHeader(account) {
    const base = this.env[account.sessionCookieEnv || "SESSION_COOKIE"] || "";
    const jar = {};
    for (const part of base.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    Object.assign(jar, this.cookies.get(account.id) || {});
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  rememberCookies(account, res) {
    const raw = res.headers && (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get && res.headers.get("set-cookie")].filter(Boolean));
    if (!raw || !raw.length) return;
    const jar = this.cookies.get(account.id) || {};
    for (const c of raw) {
      const first = String(c).split(";")[0];
      const i = first.indexOf("=");
      if (i > 0) jar[first.slice(0, i).trim()] = first.slice(i + 1).trim();
    }
    this.cookies.set(account.id, jar);
  }

  headers(account, json) {
    const h = { accept: "application/json", ...this.extra };
    if (json) h["content-type"] = "application/json; charset=utf-8";
    const token = this.env[account.authTokenEnv || "AUTH_TOKEN"];
    if (token) h.authorization = "Bearer " + token;
    const cookie = this.cookieHeader(account);
    if (cookie) h.cookie = cookie;
    const csrf = account.csrfEnv ? this.env[account.csrfEnv] : null;
    if (csrf) h["x-csrf-token"] = csrf;
    return h;
  }

  async call(account, method, url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, { method, headers: this.headers(account, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw new AdapterError(e.name === "AbortError" ? "הפורום לא ענה בזמן." : "שגיאת רשת מול הפורום: " + e.message, { status: 503, retryable: true, code: "network" });
    } finally {
      clearTimeout(timer);
    }
    this.rememberCookies(account, res);
    const text = await res.text().catch(() => "");
    if (!res.ok) throw fromHttp(res.status, text, res.headers && res.headers.get ? res.headers.get("retry-after") : null);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  async fetchNew(account, { since = "", limit = 50 } = {}) {
    const j = await this.call(account, "GET", this.url(this.ep.fetchNew, { since: since || "", limit }));
    const list = Array.isArray(j) ? j : Array.isArray(j.posts) ? j.posts : [];
    return list.filter((p) => p && p.author !== account.username).slice(0, limit);
  }

  async reply(account, { threadId, postId, text, quote = null }) {
    const j = await this.call(account, "POST", this.url(this.ep.reply, { threadId, postId }), {
      text,
      replyToPostId: postId || null,
      quote: quote && postId ? { postId: String(quote.postId || postId), author: quote.author || null, excerpt: quote.excerpt || null } : null,
    });
    return { postId: String(j.postId || j.id || ""), url: j.url || null };
  }

  async like(account, { postId, threadId }) {
    await this.call(account, "POST", this.url(this.ep.like, { postId, threadId }), {});
    return { ok: true };
  }

  async openThread(account, { forum, title, body }) {
    const j = await this.call(account, "POST", this.url(this.ep.thread, { forum }), { title, body });
    return { threadId: String(j.threadId || j.id || ""), postId: String(j.postId || ""), url: j.url || null };
  }

  async checkSession(account) {
    try {
      const j = await this.call(account, "GET", this.url(this.ep.me, {}));
      return { ok: true, username: j.username || j.name || null };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }

  async search(account, { from = null, to = null, q = "", author = null, mine = false } = {}) {
    const j = await this.call(account, "GET", this.url(this.ep.search, { q, author: mine ? account.username : author || "", from: from || "", to: to || "" }));
    const list = Array.isArray(j) ? j : Array.isArray(j.posts) ? j.posts : Array.isArray(j.results) ? j.results : [];
    return list.map((p) => ({ id: String(p.id), threadId: p.threadId != null ? String(p.threadId) : null, author: p.author || null, text: p.text || "", createdAt: p.createdAt || null, url: p.url || null }));
  }

  async fetchThread(account, threadId) {
    const j = await this.call(account, "GET", this.url(this.ep.posts, { threadId }));
    const list = Array.isArray(j) ? j : Array.isArray(j.posts) ? j.posts : [];
    return {
      thread: j.thread || { id: String(threadId) },
      posts: list.map((p) => ({ id: String(p.id), author: p.author || null, text: p.text || "", createdAt: p.createdAt || null, replyToPostId: p.replyToPostId || null, quote: p.quote || null })),
    };
  }
}

function createAdapter(env = process.env, deps = {}) {
  const kind = String(env.ADAPTER || "memory").toLowerCase();
  if (kind === "memory") return new MemoryAdapter();
  if (kind === "rest") return new RestAdapter(env, deps);
  /* מתאם חיצוני: ADAPTER=./my-adapter.js (מודול שמייצא createAdapter(env)) */
  if (kind.startsWith(".") || kind.startsWith("/")) return require(require("path").resolve(kind)).createAdapter(env, deps);
  throw new Error("מתאם לא מוכר: " + kind);
}

module.exports = { createAdapter, MemoryAdapter, RestAdapter, AdapterError, newId: () => crypto.randomUUID() };
