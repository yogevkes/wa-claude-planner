import fs from 'node:fs';

const PER_CHAT_CAP = 80;

/**
 * Stores messages of the watched chats between hourly scans.
 * chats[key] = { name, jids:[], messages:[{id, ts, fromMe, sender, text}], lastScannedTs }
 */
export class Inbox {
  constructor(file) {
    this.file = file;
    this.data = { initTs: Math.floor(Date.now() / 1000), lastScanTs: 0, chats: {} };
    if (fs.existsSync(file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      }
    }
    this.saveTimer = null;
  }

  chat(key) {
    if (!this.data.chats[key]) {
      // Messages older than the first run are kept as context only, not reported as new
      this.data.chats[key] = { name: key, jids: [], messages: [], lastScannedTs: this.data.initTs };
    }
    return this.data.chats[key];
  }

  has(key, id) {
    return Boolean(this.data.chats[key]?.messages.some((x) => x.id === id));
  }

  /** @returns {boolean} true if added (not a duplicate) */
  add(key, jid, m) {
    const c = this.chat(key);
    if (jid && !c.jids.includes(jid)) c.jids.push(jid);
    if (c.messages.some((x) => x.id === m.id)) return false;
    c.messages.push(m);
    c.messages.sort((a, b) => a.ts - b.ts);
    if (c.messages.length > PER_CHAT_CAP) c.messages = c.messages.slice(-PER_CHAT_CAP);
    this.saveSoon();
    return true;
  }

  /** New messages per chat (+ a few older ones for context) */
  pending({ contextCount = 10, maxNewPerChat = 40 } = {}) {
    const out = [];
    for (const [key, c] of Object.entries(this.data.chats)) {
      const fresh = c.messages.filter((m) => m.ts > c.lastScannedTs);
      if (!fresh.length) continue;
      const old = c.messages.filter((m) => m.ts <= c.lastScannedTs).slice(-contextCount);
      const omitted = Math.max(0, fresh.length - maxNewPerChat);
      out.push({ key, name: c.name, context: old, fresh: fresh.slice(-maxNewPerChat), omitted, maxTs: fresh[fresh.length - 1].ts });
    }
    return out;
  }

  markScanned(pending) {
    for (const p of pending) {
      const c = this.data.chats[p.key];
      c.lastScannedTs = Math.max(c.lastScannedTs, p.maxTs);
    }
    this.data.lastScanTs = Math.floor(Date.now() / 1000);
    this.save();
  }

  stats() {
    return Object.values(this.data.chats).map((c) => ({
      name: c.name,
      total: c.messages.length,
      unscanned: c.messages.filter((m) => m.ts > c.lastScannedTs).length,
    }));
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }

  save() {
    clearTimeout(this.saveTimer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
