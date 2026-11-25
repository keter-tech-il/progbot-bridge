"use strict";
/*
  הגשר (Bridge Service) – הצד השני של האפליקציה. בלי ספריות חיצוניות.

  מה האפליקציה שולחת ומושכת (החוזה מה־README של האפליקציה):
    POST /actions          פעולה חתומה מהאפליקציה: reply | like | opening (וגם forum_action_test לבדיקה)
                           כותרות: x-prog-signature (HMAC-SHA256 של הגוף עם BRIDGE_SECRET),
                           Idempotency-Key (זהה בכל הניסיונות – מונע כפילויות), x-prog-account (לא חובה)
                           תשובה: 2xx הצליח | 503/429 ניסיון חוזר | 4xx כישלון קבוע
    GET  /candidates       הודעות חדשות שלא טופלו, לחשבון שנבחר (?account=&limit=), כולל עומק השרשור
                           (threadReplies, participants, directReply, interveningReplies) לכלל התיוג
    GET  /accounts         רשימת החשבונות (עסקי / אישי...) להחלפה מהאפליקציה
    GET  /accounts/:id/check  בדיקת סשן מול הפורום
    GET  /threads/:id      השרשור המלא (?account=) – לתצוגת השיח באפליקציה
    GET  /config           לאיזה פורום הגשר מחובר, איזה מתאם, אילו חשבונות (בלי סודות)
    GET  /search           חיפוש הודעות (?account=&from=&to=&q=&author=&mine=1) – לצ'אט האישי
    GET  /health           בדיקת חיים
    GET  /log              יומן פעולות אחרונות (דורש BRIDGE_TOKEN אם הוגדר)
    רק כש־ADAPTER=memory או BRIDGE_DEV=1:
    POST /dev/seed  POST /dev/post  POST /dev/fail  POST /dev/expire  GET /dev/forum   – פורום מדומה להדגמה ובדיקות

  משתני סביבה: PORT, BRIDGE_SECRET (חובה – זהה ל־CONNECTOR_SECRET באפליקציה), BRIDGE_TOKEN (לא חובה –
  זהה ל־CONNECTOR_TOKEN), BRIDGE_STATE_FILE, ACCOUNTS / BRIDGE_ACCOUNTS_FILE, ADAPTER (memory | rest | ./my-adapter.js),
  ONE_ACCOUNT_PER_THREAD (ברירת מחדל on), BRIDGE_CORS (לבדיקות מדפדפן), והגדרות המתאם (src/adapter.js).
*/

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { createAdapter, AdapterError } = require("./src/adapter");
const { loadAccounts, publicAccount } = require("./src/accounts");
const { threadContext } = require("./src/thread");
const { BridgeState } = require("./src/state");

function createBridge(env = process.env, deps = {}) {
  const accounts = deps.accounts || loadAccounts(env, path.join(__dirname, "src"));
  const adapter = deps.adapter || createAdapter(env, deps);
  const state = new BridgeState(env.BRIDGE_STATE_FILE === "none" ? null : env.BRIDGE_STATE_FILE || path.join(__dirname, "data", "bridge-state.json"));
  const devMode = adapter.name === "memory" || env.BRIDGE_DEV === "1";
  /* BRIDGE_DEMO_SEED=1 – שרשורים לדוגמה בפורום המדומה (כדי שיהיה לבוט מה לענות בהדגמה; נטענים מחדש בכל הפעלה) */
  if (devMode && ["1", "on", "true"].includes(String(env.BRIDGE_DEMO_SEED || "").toLowerCase()) && typeof adapter.seedThread === "function" && adapter.snapshot().threads.length === 0) {
    const demo = [
      { id: "d1", forum: "מחשבים וטכנולוגיה", title: "המחשב נהיה איטי מאוד", author: "יוסי", text: "מאז העדכון האחרון המחשב שלי איטי מאוד, לוקח לו שתי דקות לעלות. מה אפשר לעשות?" },
      { id: "d2", forum: "מחשבים וטכנולוגיה", title: "מדפסת לא מדפיסה בצבע", author: "רבקה", text: "המדפסת מדפיסה רק בשחור לבן למרות שהחלפתי מחסנית צבע. מה לבדוק?" },
      { id: "d3", forum: "עסקים ויזמות", title: "מערכת לניהול לקוחות", author: "משה", text: "יש לי עסק קטן ואני מחפש מערכת פשוטה לנהל לקוחות ותשלומים. מה אתם ממליצים?" },
      { id: "d4", forum: "אוטומציה ובינה מלאכותית", title: "טופס שנכנס לגיליון", author: "שרה", text: "איך עושים שכל מי שממלא טופס באתר, הפרטים שלו ייכנסו אוטומטית לגיליון?" },
    ];
    for (const t of demo) adapter.seedThread(t);
    adapter.addPost({ threadId: "d1", author: "דוד", text: "גם אצלי קרה אחרי העדכון" });
    adapter.addPost({ threadId: "d1", author: "שמעון", text: "תבדוק כמה תוכנות עולות עם ההפעלה" });
    adapter.addPost({ threadId: "d1", author: "יוסי", text: "איך בודקים את זה? אני לא מבין בזה הרבה" });
  }
  const onePerThread = !["off", "false", "0"].includes(String(env.ONE_ACCOUNT_PER_THREAD || "on").toLowerCase());
  const inflight = new Set();

  /*
    זיהוי חשבון: לפי מזהה (business), ובנוסף לפי התווית ("עסקי") או שם המשתמש בפורום ("בונה מערכות"),
    בלי הבדל אותיות גדולות/קטנות ורווחים. בלי חשבון → חשבון ברירת המחדל.
  */
  const norm = (x) => String(x == null ? "" : x).trim().toLowerCase();
  const defaultAccount = () => accounts.find((a) => a.default) || accounts[0];
  const findAccount = (id) => {
    const k = norm(id);
    if (!k) return defaultAccount();
    return accounts.find((a) => norm(a.id) === k) || accounts.find((a) => norm(a.label) === k) || accounts.find((a) => norm(a.username) === k) || null;
  };

  function send(res, status, body, extraHeaders = {}) {
    const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders };
    if (env.BRIDGE_CORS === "1") {
      h["access-control-allow-origin"] = "*";
      h["access-control-allow-headers"] = "content-type, authorization, x-prog-signature, x-prog-job-id, x-prog-attempt, x-prog-account, x-prog-sent-at, idempotency-key";
      h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    }
    res.writeHead(status, h);
    res.end(JSON.stringify(body));
  }

  function readRaw(req, max = 256 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > max) {
          reject(Object.assign(new Error("הבקשה גדולה מדי."), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function safeEqual(a, b) {
    const x = Buffer.from(String(a || ""));
    const y = Buffer.from(String(b || ""));
    return y.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  function tokenOk(req) {
    if (!env.BRIDGE_TOKEN) return true;
    const h = req.headers.authorization || "";
    return safeEqual(h.startsWith("Bearer ") ? h.slice(7) : "", env.BRIDGE_TOKEN);
  }

  /* ---------------- POST /actions ---------------- */
  async function handleAction(req, res) {
    if (!env.BRIDGE_SECRET) return send(res, 503, { ok: false, error: "הגשר לא מוגדר: חסר BRIDGE_SECRET." });
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
    const raw = await readRaw(req);
    const expected = "sha256=" + crypto.createHmac("sha256", env.BRIDGE_SECRET).update(raw).digest("hex");
    if (!safeEqual(req.headers["x-prog-signature"], expected)) return send(res, 401, { ok: false, error: "חתימה שגויה – בדוק ש־CONNECTOR_SECRET באפליקציה זהה ל־BRIDGE_SECRET." });
    let a;
    try {
      a = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, { ok: false, error: "JSON לא תקין." });
    }
    if (a.type === "forum_action_test" || a.test) {
      state.log({ type: "test", jobId: a.jobId, msg: "הודעת בדיקה התקבלה." });
      state.save();
      return send(res, 200, { ok: true, test: true, bridge: "prog-bot-bridge" });
    }
    const key = String(req.headers["idempotency-key"] || (a.jobId ? "prog-" + a.jobId : "")).slice(0, 200);
    if (!key) return send(res, 400, { ok: false, error: "חסר Idempotency-Key / jobId." });
    const prev = state.data.actions[key];
    if (prev && prev.final) {
      return send(res, prev.status, { ...prev.body, duplicate: true });
    }
    if (inflight.has(key)) return send(res, 425, { ok: false, retryable: true, error: "הפעולה הזאת כבר בביצוע." });

    const accountId = a.account || req.headers["x-prog-account"] || null;
    const account = findAccount(accountId);
    if (!account) return finish(422, { ok: false, error: `חשבון לא מוכר: ${accountId}.` });

    const action = a.action;
    if (!["reply", "like", "opening"].includes(action)) return finish(422, { ok: false, error: "פעולה לא מוכרת: " + action });
    if (action === "reply" && (!a.threadId || !String(a.text || "").trim())) return finish(422, { ok: false, error: "תגובה צריכה threadId וטקסט." });
    if (action === "like" && !a.postId) return finish(422, { ok: false, error: "לייק צריך postId." });
    let title = a.title, body = a.body;
    if (action === "opening") {
      if (!title || !body) {
        const lines = String(a.text || "").split("\n");
        title = title || lines.shift();
        body = body || lines.join("\n").trim();
      }
      if (!title || !body || !a.forum) return finish(422, { ok: false, error: "פתיחת דיון צריכה כותרת, טקסט ופורום." });
    }
    /* אותו שרשור – אותו חשבון: לא מערבבים חשבונות באותה שיחה */
    const owner = a.threadId ? state.data.threads[a.threadId] : null;
    if (onePerThread && owner && owner !== account.id) {
      return finish(409, { ok: false, error: `בשרשור הזה כבר פעל החשבון "${owner}". לא מערבבים חשבונות באותו שרשור.` });
    }

    inflight.add(key);
    try {
      let r;
      if (action === "reply") {
        /* מענה להודעה הספציפית (replyToPostId, או postId), וציטוט שלה כשהאפליקציה ביקשה (quote) */
        const target = a.replyToPostId || a.postId || null;
        const quote = a.quote && typeof a.quote === "object" && target ? { postId: String(a.quote.postId || target), author: a.quote.author ? String(a.quote.author).slice(0, 120) : null, excerpt: a.quote.excerpt ? String(a.quote.excerpt).slice(0, 300) : null } : null;
        r = await adapter.reply(account, { threadId: String(a.threadId), postId: target ? String(target) : null, text: String(a.text).trim(), quote });
      }
      else if (action === "like") r = await adapter.like(account, { postId: String(a.postId), threadId: a.threadId ? String(a.threadId) : null });
      else r = await adapter.openThread(account, { forum: String(a.forum), title: String(title).trim(), body: String(body).trim() });
      const threadId = a.threadId || (r && r.threadId) || null;
      if (threadId) state.data.threads[threadId] = account.id;
      if (a.replyToPostId && a.replyToPostId !== a.postId) state.data.handled[`${account.id}:${a.replyToPostId}`] = { at: new Date().toISOString(), action };
      if (a.postId) state.data.handled[`${account.id}:${a.postId}`] = { at: new Date().toISOString(), action };
      state.log({ type: action, account: account.id, jobId: a.jobId, threadId, postId: r && r.postId, mention: a.mention || null, quote: a.quote ? String(a.replyToPostId || a.postId || "") : null, msg: "בוצע." });
      return finish(200, { ok: true, action, account: account.id, ...(r || {}) });
    } catch (e) {
      const err = e instanceof AdapterError ? e : new AdapterError(e.message, { status: 503, retryable: true });
      state.log({ type: "error", account: account.id, jobId: a.jobId, code: err.code, msg: err.message });
      if (err.retryable) {
        /* זמני – לא שומרים כתוצאה סופית, כדי שהניסיון הבא באמת ינסה */
        state.save();
        const headers = err.status === 429 && err.retryAfterSec ? { "retry-after": String(err.retryAfterSec) } : {};
        return send(res, err.status === 429 ? 429 : 503, { ok: false, retryable: true, code: err.code, error: err.message }, headers);
      }
      return finish(err.status >= 400 && err.status < 500 ? err.status : 422, { ok: false, retryable: false, code: err.code, error: err.message });
    } finally {
      inflight.delete(key);
    }

    function finish(status, bodyOut) {
      state.data.actions[key] = { at: new Date().toISOString(), final: true, status, body: bodyOut };
      state.save();
      return send(res, status, bodyOut);
    }
  }

  /* ---------------- GET /candidates ---------------- */
  async function handleCandidates(req, res, url) {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
    /* מקור ההודעות לא מחזיר 404 בגלל חשבון: חשבון לא מוכר → חשבון ברירת המחדל + אזהרה בתשובה */
    const asked = url.searchParams.get("account");
    let account = findAccount(asked);
    let warning = null;
    if (!account) {
      account = defaultAccount();
      warning = `החשבון "${String(asked).slice(0, 40)}" לא מוכר בגשר – הוחזרו הודעות של חשבון ברירת המחדל (${account.id}). באפליקציה: "טען חשבונות מהגשר" ובחר מחדש.`;
      console.warn("[bridge] candidates: unknown account", JSON.stringify(String(asked).slice(0, 40)), "→", account.id);
    }
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const redeliver = url.searchParams.get("redeliver") === "1";
    let posts;
    try {
      posts = await adapter.fetchNew(account, { since: state.data.since[account.id] || null, limit: 200 });
    } catch (e) {
      const err = e instanceof AdapterError ? e : new AdapterError(e.message, { status: 503, retryable: true });
      return send(res, err.retryable ? 503 : err.status, { ok: false, code: err.code, error: err.message });
    }
    /*
      ברירת מחדל: כל ההודעות שלא טופלו חוזרות – גם כמה הודעות מאותו שרשור. האפליקציה מחליטה על כל אחת
      (תגובה / לייק / דילוג) לפי המכסות, הזמנים, השבת והמקסימום לשרשור, ועונה בציטוט להודעה הספציפית.
      LATEST_PER_THREAD=on – מצב מצומצם: רק ההודעה האחרונה שלא טופלה בכל שרשור.
    */
    const latestOnly = ["on", "true", "1"].includes(String(env.LATEST_PER_THREAD || "off").toLowerCase());
    const lastIdx = new Map();
    const myLast = new Map();
    posts.forEach((p, i) => {
      const tid = String(p.threadId);
      if (p.author === account.username) myLast.set(tid, i);
      else lastIdx.set(tid, i);
    });
    const events = [];
    for (const [i, p] of posts.entries()) {
      if (p.author === account.username) continue;
      const dkey = `${account.id}:${p.id}`;
      if (state.data.handled[dkey]) continue;
      if (!redeliver && state.data.delivered[dkey]) continue;
      if (onePerThread && state.data.threads[p.threadId] && state.data.threads[p.threadId] !== account.id) continue;
      const tid = String(p.threadId);
      const tp = Array.isArray(p.threadPosts) ? p.threadPosts : [];
      const at = tp.findIndex((x) => String(x.id) === String(p.id));
      const answeredAfter = (myLast.has(tid) && myLast.get(tid) > i) || (at >= 0 && tp.slice(at + 1).some((x) => x.author === account.username));
      if (latestOnly && (lastIdx.get(tid) !== i || answeredAfter)) {
        state.data.delivered[dkey] = "superseded:" + new Date().toISOString();
        continue;
      }
      const ctx = threadContext(p, account.username);
      events.push({
        id: `${account.id}:${p.threadId}:${p.id}`,
        account: account.id,
        threadId: String(p.threadId),
        postId: String(p.id),
        author: p.author,
        message: p.text,
        url: p.url || null,
        forum: p.forum || null,
        threadTitle: p.threadTitle || null,
        receivedAt: p.createdAt || new Date().toISOString(),
        ...ctx,
      });
      state.data.delivered[dkey] = new Date().toISOString();
      if (events.length >= limit) break;
    }
    /* בתוך כל שרשור – מהחדשה לישנה: אם יש מקסימום תגובות לשרשור, התגובות הולכות להודעות העדכניות
       (בדרך כלל השאלה הפתוחה), והישנות מקבלות לייק. סדר השרשורים עצמם נשמר. */
    const order = [...new Set(events.map((e) => e.threadId))];
    events.sort((x, y) => order.indexOf(x.threadId) - order.indexOf(y.threadId) || (y.threadReplies || 0) - (x.threadReplies || 0));
    state.save();
    return send(res, 200, warning ? { ok: true, account: account.id, events, warning } : { ok: true, account: account.id, events });
  }

  /* ---------------- /dev – פורום מדומה ---------------- */
  async function handleDev(req, res, url) {
    if (!devMode || typeof adapter.seedThread !== "function") return send(res, 404, { ok: false, error: "לא נמצא." });
    /* כשהגשר באינטרנט עם BRIDGE_TOKEN – גם הפורום המדומה דורש את הטוקן */
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
    const body = req.method === "POST" ? JSON.parse((await readRaw(req)).toString("utf8") || "{}") : {};
    if (url.pathname === "/dev/seed") return send(res, 200, { ok: true, thread: adapter.seedThread(body) });
    if (url.pathname === "/dev/post") return send(res, 200, { ok: true, post: adapter.addPost(body) });
    if (url.pathname === "/dev/fail") {
      adapter.failNext(body.op || "*", body.status || 503, body.code, body.times || 1, body.retryAfterSec || null);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/dev/expire") {
      if (body.restore) adapter.sessions.delete(body.account);
      else adapter.sessions.add(body.account);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/dev/forum") return send(res, 200, { ok: true, ...adapter.snapshot() });
    return send(res, 404, { ok: false, error: "לא נמצא." });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    /* ניקוי שאריות הדבקה בנתיב, למשל "/candidates](https://...)" → "/candidates" */
    {
      let p = url.pathname;
      try { p = decodeURIComponent(p); } catch {}
      const cut = p.search(/[\]\[()<>"'\s]|%5[bd]|%28|%29/i);
      if (cut > 0) p = p.slice(0, cut);
      if (p.length > 1) p = p.replace(/\/+$/, "") || "/";
      if (p !== url.pathname) url.pathname = p;
    }
    /* יומן בקשות קצר ב־Render (בלי טוקנים ובלי תוכן): שיטה, נתיב, חשבון, סטטוס, זמן */
    if (env.BRIDGE_QUIET !== "1" && process.env.NODE_ENV !== "test") {
      const t0 = Date.now();
      res.on("finish", () => {
        if (url.pathname === "/health") return;
        const acc = url.searchParams.get("account");
        console.log(`[bridge] ${req.method} ${url.pathname}${acc ? " account=" + acc.slice(0, 30) : ""} → ${res.statusCode} (${Date.now() - t0}ms)`);
      });
    }
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, adapter: adapter.name, accounts: accounts.length, secret: Boolean(env.BRIDGE_SECRET) });
      }
      if (req.method === "POST" && (url.pathname === "/actions" || url.pathname === "/")) return await handleAction(req, res);
      /* כתובת הבסיס – הסבר קצר במקום 404 (מי שפותח בדפדפן או טועה בכתובת יודע מה לשים באפליקציה) */
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        return send(res, 200, {
          ok: true, service: "progbot-bridge", adapter: adapter.name,
          app: { CONNECTOR_URL: "<כתובת הגשר>/actions", CONNECTOR_CANDIDATES_URL: "<כתובת הגשר>/candidates" },
          endpoints: ["POST /actions", "GET /candidates", "GET /accounts", "GET /threads/:id", "GET /search", "GET /config", "GET /health"],
        });
      }
      if (req.method === "GET" && (url.pathname === "/candidates" || url.pathname === "/candidates/")) return await handleCandidates(req, res, url);
      if (req.method === "GET" && url.pathname === "/accounts") {
        if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
        return send(res, 200, { ok: true, accounts: accounts.map((a) => publicAccount(a, env)) });
      }
      const m = url.pathname.match(/^\/accounts\/([\w-]+)\/check$/);
      if (req.method === "GET" && m) {
        if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
        const acc = findAccount(m[1]);
        if (!acc) return send(res, 404, { ok: false, code: "unknown_account", error: "חשבון לא מוכר." });
        return send(res, 200, { account: acc.id, ...(await adapter.checkSession(acc)) });
      }
      const tm = url.pathname.match(/^\/threads\/([^/]+)$/);
      if (req.method === "GET" && tm) {
        if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
        const acc = findAccount(url.searchParams.get("account"));
        if (!acc) return send(res, 404, { ok: false, code: "unknown_account", error: "חשבון לא מוכר." });
        if (typeof adapter.fetchThread !== "function") return send(res, 501, { ok: false, error: "המתאם לא תומך בשליפת שרשור." });
        try {
          const r = await adapter.fetchThread(acc, decodeURIComponent(tm[1]));
          const mine = (r.posts || []).map((p) => ({ ...p, mine: p.author === acc.username }));
          return send(res, 200, { ok: true, account: acc.id, owner: state.data.threads[decodeURIComponent(tm[1])] || null, thread: r.thread || null, posts: mine });
        } catch (e) {
          const err = e instanceof AdapterError ? e : new AdapterError(e.message, { status: 503, retryable: true });
          return send(res, err.retryable ? 503 : err.status, { ok: false, code: err.code, error: err.message });
        }
      }
      if (req.method === "GET" && url.pathname === "/search") {
        if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
        const acc = findAccount(url.searchParams.get("account"));
        if (!acc) return send(res, 404, { ok: false, code: "unknown_account", error: "חשבון לא מוכר." });
        if (typeof adapter.search !== "function") return send(res, 501, { ok: false, error: "המתאם לא תומך בחיפוש." });
        try {
          const posts = await adapter.search(acc, {
            from: url.searchParams.get("from"), to: url.searchParams.get("to"), q: url.searchParams.get("q") || "",
            author: url.searchParams.get("author"), mine: url.searchParams.get("mine") === "1",
          });
          return send(res, 200, { ok: true, account: acc.id, posts: posts.map((p) => ({ ...p, mine: p.author === acc.username })) });
        } catch (e) {
          const err = e instanceof AdapterError ? e : new AdapterError(e.message, { status: 503, retryable: true });
          return send(res, err.retryable ? 503 : err.status, { ok: false, code: err.code, error: err.message });
        }
      }
      if (req.method === "GET" && url.pathname === "/config") {
        if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
        let forum = adapter.name === "memory" ? "פורום מדומה (בדיקות)" : null;
        try {
          if (env.FORUM_API_BASE) forum = new URL(env.FORUM_API_BASE).host;
        } catch {}
        return send(res, 200, {
          ok: true, adapter: adapter.name, forum, accounts: accounts.map((a) => publicAccount(a, env)),
          latestOnly: ["on", "true", "1"].includes(String(env.LATEST_PER_THREAD || "off").toLowerCase()), onePerThread,
        });
      }
      if (req.method === "GET" && url.pathname === "/log") {
        if (!tokenOk(req)) return send(res, 401, { ok: false, error: "טוקן שגוי." });
        return send(res, 200, { ok: true, log: state.data.log.slice(-100).reverse() });
      }
      if (url.pathname.startsWith("/dev/")) return await handleDev(req, res, url);
      return send(res, 404, { ok: false, error: "לא נמצא." });
    } catch (e) {
      console.error("[bridge]", e);
      return send(res, e.status || 500, { ok: false, error: e.message });
    }
  });

  return { server, adapter, accounts, state };
}

module.exports = { createBridge };

if (require.main === module) {
  const { server, adapter, accounts } = createBridge(process.env);
  const port = Number(process.env.PORT) || 8787;
  server.listen(port, () => {
    console.log(`prog-bot-bridge on ${port} · adapter: ${adapter.name} · accounts: ${accounts.map((a) => a.id + (a.default ? "*" : "")).join(", ")}`);
    if (!process.env.BRIDGE_SECRET) console.warn("אזהרה: חסר BRIDGE_SECRET – הגשר לא יקבל פעולות.");
  });
}
