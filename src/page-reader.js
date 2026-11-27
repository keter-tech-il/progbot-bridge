"use strict";
/*
  קריאה בלבד מקישור מותאם: מושך עמוד / שרשור מכתובת שהמשתמש הדביק, מחלץ ממנו הודעות,
  ומחזיר מבנה אחיד. אין כאן שום שליחה או תגובה – רק קריאה.

  readPage(url) → {
    ok, status, url, finalUrl, site, title, kind: "xenforo" | "jsonld" | "articles" | "paragraphs",
    items: [{ id, author, text, at, url, index }], warnings: [], ms
  }
  בשגיאה: { ok:false, code, status, error } – code אחד מ:
    bad_url | blocked_host | blocked(403) | not_found(404) | rate_limited(429) | server_error(5xx)
    | timeout | network | not_html | too_large | no_items
*/

const dns = require("dns").promises;
const net = require("net");

const UA = "Mozilla/5.0 (compatible; ProgBotReader/1.0; read-only test bot)";
const MAX_BYTES = 3 * 1024 * 1024;

/* ---------- כתובת ---------- */
function cleanInputUrl(raw) {
  let t = String(raw || "").trim();
  const m = t.match(/https?:\/\/[^\s\[\]()<>"']+/i);
  if (m) t = m[0];
  t = t.replace(/[.,;]+$/, "");
  if (t && !/^https?:\/\//i.test(t) && /^[\w.-]+\.[a-z]{2,}/i.test(t)) t = "https://" + t;
  return t;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80")) return true;
    const v4 = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isPrivateIp(v4[1]);
  }
  return false;
}

/* הגנה: לא קוראים כתובות פנימיות (localhost, רשת ביתית, ענן פנימי) */
async function checkHost(u, opts) {
  if (opts.allowPrivate) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(host) || /\.local$/i.test(host) || /\.internal$/i.test(host)) return "כתובת פנימית – אסור לקרוא ממנה.";
  if (net.isIP(host)) return isPrivateIp(host) ? "כתובת פנימית – אסור לקרוא ממנה." : null;
  try {
    const addrs = await (opts.lookup || dns.lookup)(host, { all: true });
    if (!addrs.length) return "שם האתר לא נמצא.";
    if (addrs.some((a) => isPrivateIp(a.address))) return "הכתובת מובילה לרשת פנימית – אסור לקרוא ממנה.";
  } catch {
    return "שם האתר לא נמצא (DNS).";
  }
  return null;
}

/* ---------- HTML → טקסט ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
  });
}

/* מוצא את התגית הסוגרת התואמת (סופר פתיחות/סגירות של אותו שם) */
function balancedInner(html, openIdx, tag) {
  const openEnd = html.indexOf(">", openIdx);
  if (openEnd < 0) return null;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = openEnd + 1;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { inner: html.slice(openEnd + 1, m.index), end: re.lastIndex };
  }
  return { inner: html.slice(openEnd + 1), end: html.length };
}

function removeBlocks(html, tag) {
  let out = html;
  const re = new RegExp(`<${tag}\\b`, "i");
  let guard = 0;
  let m;
  while ((m = re.exec(out)) && guard++ < 200) {
    const b = balancedInner(out, m.index, tag);
    out = out.slice(0, m.index) + " " + out.slice(b ? b.end : m.index + 1);
  }
  return out;
}

function htmlToText(html, { dropQuotes = true } = {}) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  for (const t of ["script", "style", "noscript", "svg", "template"]) h = removeBlocks(h, t);
  if (dropQuotes) h = removeBlocks(h, "blockquote");
  h = h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n").replace(/<li\b[^>]*>/gi, "• ");
  h = h.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, (m, a) => (a && !/^[:;]/.test(a) ? ` ${a} ` : " "));
  h = h.replace(/<[^>]+>/g, " ");
  h = decodeEntities(h);
  return h.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function attr(tagHtml, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tagHtml);
  return m ? decodeEntities(m[2] != null ? m[2] : m[3]) : null;
}

function pageTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]*>/i.exec(html);
  if (og) { const c = attr(og[0], "content"); if (c) return c.trim(); }
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? htmlToText(t[1]).replace(/\s*\|\s*[^|]+$/, "").trim() : null;
}

/* ---------- מפרסרים ---------- */

/* פורומים מסוג XenForo (כמו פרוג): <article class="message ..." data-author="..." data-content="post-123"> + <div class="bbWrapper"> */
function parseXenforo(html, baseUrl) {
  const items = [];
  const re = /<article\b[^>]*\bclass=["'][^"']*\bmessage\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const block = balancedInner(html, m.index, "article");
    if (!block) continue;
    const inner = block.inner;
    const author = attr(tag, "data-author");
    const content = attr(tag, "data-content") || attr(tag, "id") || "";
    const pid = (content.match(/(\d+)/) || [])[1] || null;
    const bb = /<div\b[^>]*\bclass=["'][^"']*\bbbWrapper\b[^"']*["'][^>]*>/i.exec(inner);
    if (!bb) continue;
    const body = balancedInner(inner, bb.index, "div");
    const text = htmlToText(body ? body.inner : "");
    const timeTag = /<time\b[^>]*>/i.exec(inner);
    const at = timeTag ? attr(timeTag[0], "datetime") || (attr(timeTag[0], "data-time") ? new Date(Number(attr(timeTag[0], "data-time")) * 1000).toISOString() : null) : null;
    const link = /<a\b[^>]*href=["']([^"']*\/post-\d+[^"']*)["']/i.exec(inner);
    if (!text) continue;
    items.push({ id: pid ? "post-" + pid : null, author, text, at, url: link ? absUrl(link[1], baseUrl) : pid ? baseUrl.split("#")[0] + "#post-" + pid : null });
    re.lastIndex = block.end;
  }
  return items;
}

/* נתונים מובנים (JSON-LD): DiscussionForumPosting / Comment / SocialMediaPosting */
function parseJsonLd(html, baseUrl) {
  const items = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visit);
    if (o["@graph"]) visit(o["@graph"]);
    const t = [].concat(o["@type"] || []).join(",");
    if (/DiscussionForumPosting|Comment|SocialMediaPosting|Answer|Question/.test(t)) {
      const text = htmlToText(o.text || o.articleBody || o.description || "");
      const author = o.author ? (typeof o.author === "string" ? o.author : o.author.name || (Array.isArray(o.author) && o.author[0] && o.author[0].name)) : null;
      if (text) items.push({ id: o["@id"] || o.identifier || null, author: author || null, text, at: o.datePublished || o.dateCreated || null, url: o.url ? absUrl(o.url, baseUrl) : null });
    }
    for (const k of ["comment", "comments", "hasPart", "suggestedAnswer", "acceptedAnswer", "mainEntity"]) if (o[k]) visit(o[k]);
  };
  while ((m = re.exec(html))) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* JSON-LD שבור – מדלגים */ }
  }
  return items;
}

/* כללי: <article> נפרדים (בלוגים, תגובות) */
function parseArticles(html, baseUrl) {
  const items = [];
  const re = /<article\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const b = balancedInner(html, m.index, "article");
    if (!b) continue;
    const text = htmlToText(b.inner);
    if (text.length >= 20) items.push({ id: attr(m[0], "id"), author: null, text: text.slice(0, 4000), at: null, url: null });
    re.lastIndex = b.end;
  }
  return items.length >= 2 ? items : [];
}

/* מוצא אחרון: פסקאות התוכן הראשי של הדף (פריט אחד) */
function parseParagraphs(html) {
  let main = /<main\b[^>]*>/i.exec(html);
  let scope = html;
  if (main) { const b = balancedInner(html, main.index, "main"); if (b) scope = b.inner; }
  else { const body = /<body\b[^>]*>/i.exec(html); if (body) { const b = balancedInner(html, body.index, "body"); if (b) scope = b.inner; } }
  scope = removeBlocks(removeBlocks(removeBlocks(scope, "nav"), "header"), "footer");
  const ps = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(scope))) { const t = htmlToText(m[1]); if (t.length >= 25) ps.push(t); }
  const text = ps.join("\n\n").slice(0, 4000);
  return text ? [{ id: null, author: null, text, at: null, url: null }] : [];
}

function absUrl(u, base) {
  try { return new URL(u, base).toString(); } catch { return null; }
}

/* מזהה יציב להודעה בלי מזהה: לפי כותב + תחילת הטקסט */
function stableId(it, i) {
  if (it.id) return String(it.id).slice(0, 80);
  const s = `${it.author || ""}|${it.text.slice(0, 200)}`;
  let h = 5381;
  for (let k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) >>> 0;
  return "i" + h.toString(36) + "-" + i;
}

function parseHtml(html, url) {
  const title = pageTitle(html);
  const tries = [["xenforo", parseXenforo], ["jsonld", parseJsonLd], ["articles", parseArticles], ["paragraphs", parseParagraphs]];
  for (const [kind, fn] of tries) {
    let items = [];
    try { items = fn(html, url) || []; } catch { items = []; }
    items = items.filter((x) => x && x.text && x.text.trim());
    if (items.length) {
      return {
        kind,
        title,
        items: items.slice(0, 200).map((x, i) => ({
          id: stableId(x, i),
          author: x.author ? String(x.author).slice(0, 120) : null,
          text: x.text.trim().slice(0, 4000),
          at: x.at && !isNaN(new Date(x.at)) ? new Date(x.at).toISOString() : null,
          url: x.url || null,
          index: i,
        })),
      };
    }
  }
  return { kind: null, title, items: [] };
}

/* ---------- משיכה ---------- */
const ERR = {
  bad_url: "הקישור לא תקין. צריך כתובת מלאה שמתחילה ב־https://",
  blocked: "האתר חוסם קריאה מהשרת (403). חלק מהאתרים לא מאפשרים קריאה אוטומטית משרתים בענן.",
  not_found: "הדף לא נמצא (404). בדוק שהקישור נכון ושהדף פתוח לכולם (לא דורש התחברות).",
  auth: "הדף דורש התחברות (401). אפשר לקרוא רק דפים שפתוחים לכולם.",
  rate_limited: "האתר ביקש להאט (429). נסה שוב בעוד כמה דקות.",
  server_error: "האתר מחזיר שגיאה בצד שלו. נסה שוב מאוחר יותר.",
  timeout: "האתר לא ענה בזמן (פסק זמן).",
  network: "אין חיבור לאתר (שגיאת רשת).",
  not_html: "הקישור לא מוביל לדף אינטרנט רגיל (לא HTML).",
  too_large: "הדף גדול מדי לקריאה.",
  no_items: "הדף נקרא, אבל לא נמצאו בו הודעות או תוכן. ייתכן שהתוכן נטען רק בדפדפן (JavaScript) או שמבנה הדף שונה מהצפוי.",
};

function fail(code, extra = {}) {
  return { ok: false, code, error: ERR[code] || extra.error || "שגיאה בקריאת הדף.", ...extra };
}

async function readPage(rawUrl, opts = {}) {
  const t0 = Date.now();
  const fetchFn = opts.fetch || fetch;
  const timeoutMs = opts.timeoutMs || 15000;
  const input = cleanInputUrl(rawUrl);
  let u;
  try { u = new URL(input); } catch { return fail("bad_url", { url: input || null }); }
  if (!/^https?:$/.test(u.protocol)) return fail("bad_url", { url: input });
  const hostErr = await checkHost(u, opts);
  if (hostErr) return fail("blocked_host", { error: hostErr, url: u.toString() });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  let html = "";
  try {
    /* הפניות: עוקבים ידנית כדי לבדוק כל כתובת ביניים (שלא תוביל לרשת פנימית) */
    let cur = u;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetchFn(cur.toString(), { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "he,en;q=0.8" }, redirect: "manual", signal: ctrl.signal });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
        const next = new URL(res.headers.get("location"), cur);
        const e2 = await checkHost(next, opts);
        if (e2) return fail("blocked_host", { error: e2, url: next.toString() });
        cur = next;
        continue;
      }
      break;
    }
    const finalUrl = cur.toString();
    const status = res.status;
    if (status === 401) return fail("auth", { status, url: finalUrl });
    if (status === 403) return fail("blocked", { status, url: finalUrl });
    if (status === 404 || status === 410) return fail("not_found", { status, url: finalUrl });
    if (status === 429) return fail("rate_limited", { status, url: finalUrl });
    if (status >= 500) return fail("server_error", { status, url: finalUrl });
    if (status >= 300) return fail("server_error", { status, url: finalUrl, error: `האתר החזיר קוד ${status}.` });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (ctype && !/html|xml/.test(ctype)) return fail("not_html", { status, url: finalUrl, contentType: ctype });
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) return fail("too_large", { status, url: finalUrl });
    html = await res.text();
    if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);
    /* דף "בדיקת דפדפן" (Cloudflare וכד') – זה בפועל חסימה */
    if (/cf-browser-verification|challenge-platform|Just a moment\.\.\.|Attention Required!/i.test(html.slice(0, 20000))) return fail("blocked", { status, url: finalUrl, error: "האתר מציג בדיקת דפדפן (הגנה מבוטים) ולא מאפשר קריאה מהשרת." });
    const parsed = parseHtml(html, finalUrl);
    if (!parsed.items.length) return fail("no_items", { status, url: finalUrl, title: parsed.title });
    const warnings = [];
    if (parsed.kind === "paragraphs") warnings.push("לא זוהו הודעות נפרדות – נקרא התוכן הראשי של הדף כפריט אחד.");
    if (parsed.kind === "articles") warnings.push("מבנה כללי – ייתכן שחלק מהפריטים אינם הודעות.");
    return {
      ok: true,
      status,
      url: u.toString(),
      finalUrl,
      site: new URL(finalUrl).hostname.replace(/^www\./, ""),
      title: parsed.title,
      kind: parsed.kind,
      items: parsed.items,
      warnings,
      ms: Date.now() - t0,
    };
  } catch (e) {
    if (e && e.name === "AbortError") return fail("timeout", { url: u.toString() });
    return fail("network", { url: u.toString(), detail: String((e && e.message) || "").slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }
}

/* מזהה יציב לשרשור לפי הכתובת (בלי # ופרמטרים של מעקב) */
function threadKey(url) {
  try {
    const x = new URL(url);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/.test(k)) x.searchParams.delete(k);
    const s = x.toString().replace(/\/page-\d+\/?$/, "/");
    let h = 5381;
    for (let k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) >>> 0;
    return "url-" + h.toString(36);
  } catch {
    return "url-invalid";
  }
}

/* פריטי הדף → הודעות מועמדות באותו מבנה של /candidates (לקריאה בלבד) */
function toCandidates(page, account, { myName = null } = {}) {
  const tid = threadKey(page.finalUrl || page.url);
  const posts = page.items;
  return posts
    .filter((p) => !myName || p.author !== myName)
    .map((p) => {
      const idx = posts.indexOf(p);
      return {
        id: `${tid}:${p.id}`,
        account,
        threadId: tid,
        postId: p.id,
        author: p.author,
        message: p.text,
        url: p.url || page.finalUrl,
        forum: page.site,
        threadTitle: page.title,
        receivedAt: p.at || null,
        threadReplies: Math.max(0, posts.length - 1),
        participants: [...new Set(posts.map((x) => x.author).filter(Boolean))].slice(0, 50),
        directReply: false,
        newerReplies: posts.length - 1 - idx,
        context: posts.slice(Math.max(0, idx - 6), idx).map((c) => ({ id: c.id, author: c.author, text: c.text.slice(0, 600), at: c.at })),
        readOnly: true,
        source: "link",
      };
    });
}

module.exports = { readPage, parseHtml, htmlToText, cleanInputUrl, isPrivateIp, toCandidates, threadKey, ERR };
