"use strict";
/*
  מצב הגשר בקובץ JSON (כתיבה אטומית + גיבוי):
    actions   תוצאה לכל Idempotency-Key – בקשה חוזרת מחזירה אותה תוצאה בלי לפרסם שוב
    handled   הודעות שכבר טופלו (תגובה/לייק) לכל חשבון – לא חוזרות במקור ההודעות
    delivered הודעות שכבר נמסרו לאפליקציה – לא נמסרות שוב
    threads   איזה חשבון פעל בכל שרשור (אותו שרשור – אותו חשבון)
    since     עד איזה זמן נמשכו הודעות מהפורום, לכל חשבון
    log       יומן פעולות (300 אחרונות)
*/
const fs = require("fs");
const path = require("path");

class BridgeState {
  constructor(file) {
    this.file = file;
    this.data = { actions: {}, handled: {}, delivered: {}, threads: {}, since: {}, log: [] };
    if (file) {
      for (const f of [file, file + ".bak"]) {
        try {
          this.data = { ...this.data, ...JSON.parse(fs.readFileSync(f, "utf8")) };
          break;
        } catch {
          /* אין קובץ / פגום – נסה גיבוי */
        }
      }
    }
  }

  save() {
    if (!this.file) return;
    this.prune();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + ".bak");
    fs.renameSync(tmp, this.file);
  }

  prune() {
    const limit = Date.now() - 30 * 24 * 3600 * 1000;
    for (const k of ["actions", "handled", "delivered"]) {
      for (const [key, v] of Object.entries(this.data[k])) if (new Date(v.at || v).getTime() < limit) delete this.data[k][key];
    }
    if (this.data.log.length > 300) this.data.log.splice(0, this.data.log.length - 300);
  }

  log(entry) {
    this.data.log.push({ at: new Date().toISOString(), ...entry });
  }
}

module.exports = { BridgeState };
