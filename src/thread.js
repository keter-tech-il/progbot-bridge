"use strict";
/*
  הקשר השרשור לכל הודעה – בשביל כלל התיוג באפליקציה:
    threadReplies       כמה תשובות יש בשרשור עד ההודעה הזאת (בלי ההודעה הפותחת)
    participants        מי כתב בשרשור עד עכשיו (שמות)
    directReply         ההודעה עונה ישירות לחשבון שלי (תשובה אליי או ציטוט שלי)
    interveningReplies  כמה הודעות של אחרים נכתבו מאז ההודעה האחרונה שלי ועד ההודעה הזאת (לא כולל אותה)
    newerReplies        כמה הודעות נכתבו בשרשור אחרי ההודעה הזאת – אם יש, התגובה תהיה מענה/ציטוט להודעה עצמה
    context             עד 6 ההודעות שלפניה (מי כתב ומה) – לתצוגת השיח המלא באפליקציה
  אם המתאם כבר נתן מספרים מוכנים – משתמשים בהם.
*/
function threadContext(post, username) {
  const has = (k) => post[k] !== undefined && post[k] !== null;
  if (has("threadReplies") && !Array.isArray(post.threadPosts)) {
    return {
      threadReplies: Number(post.threadReplies) || 0,
      participants: post.participants || 0,
      directReply: Boolean(post.directReply),
      interveningReplies: Number(post.interveningReplies) || 0,
      newerReplies: Number(post.newerReplies) || 0,
      context: Array.isArray(post.context) ? post.context.slice(-6) : [],
    };
  }
  const posts = Array.isArray(post.threadPosts) && post.threadPosts.length ? post.threadPosts : [{ id: post.id, author: post.author }];
  const found = posts.findIndex((p) => String(p.id) === String(post.id));
  const idx = Math.max(0, found);
  const newerReplies = found >= 0 ? posts.length - found - 1 : Number(post.newerReplies) || 0;
  const upto = posts.slice(0, idx + 1);
  const participants = [...new Set(upto.map((p) => p.author).filter(Boolean))];
  const directReply = post.replyToAuthor === username || (Array.isArray(post.quotedAuthors) && post.quotedAuthors.includes(username));
  let lastMine = -1;
  for (let i = 0; i < idx; i++) if (upto[i].author === username) lastMine = i;
  const intervening = lastMine >= 0 ? upto.slice(lastMine + 1, idx).filter((p) => p.author !== username).length : idx;
  const context = posts
    .slice(Math.max(0, idx - 6), idx)
    .filter((p) => p.text != null)
    .map((p) => ({ id: String(p.id), author: p.author || null, text: String(p.text || "").slice(0, 600), at: p.createdAt || null }));
  return { threadReplies: Math.max(0, idx), participants, directReply, interveningReplies: intervening, newerReplies, context };
}

module.exports = { threadContext };
