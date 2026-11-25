import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  getContentType,
  generateMessageID,
} from 'baileys';
import { paths } from './config.js';
import { makeWatchMatcher, normName } from './names.js';

const toNum = (ts) => Number(ts?.toNumber ? ts.toNumber() : ts || 0);
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

/** Extract what we care about from a raw Baileys message (pure; exported for tests) */
export function extractContent(msg) {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type || ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(type)) return null;
  const c = content[type] || {};
  const out = { type, text: '' };
  if (type === 'conversation') out.text = content.conversation || '';
  else if (type === 'extendedTextMessage') out.text = c.text || '';
  else if (type === 'imageMessage') { out.text = c.caption || ''; out.media = 'image'; out.ext = (c.mimetype || '').includes('png') ? 'png' : 'jpg'; }
  else if (type === 'documentMessage' || type === 'documentWithCaptionMessage') {
    const doc = type === 'documentWithCaptionMessage' ? content[type]?.message?.documentMessage || {} : c;
    out.text = doc.caption || '';
    const name = doc.fileName || '';
    const mime = doc.mimetype || '';
    if (mime.includes('pdf') || /\.pdf$/i.test(name)) { out.media = 'document'; out.ext = 'pdf'; }
    else if (mime.startsWith('image/')) { out.media = 'document'; out.ext = mime.includes('png') ? 'png' : 'jpg'; }
    else out.note = `קובץ "${name}" מסוג שלא נתמך – רק תמונות ו-PDF`;
    if (name) out.text = `${out.text} [קובץ: ${name}]`.trim();
  } else if (type === 'audioMessage') out.note = 'הודעה קולית – עדיין לא נתמכת, ענה למשתמש שיכתוב בטקסט';
  else if (type === 'videoMessage') { out.text = c.caption || ''; out.note = 'סרטון – התוכן עצמו לא נקרא'; }
  else if (type === 'contactMessage') out.text = `[איש קשר: ${c.displayName || ''}] ${c.vcard || ''}`.slice(0, 800);
  else if (type === 'locationMessage') out.text = `[מיקום: ${c.name || ''} ${c.address || ''} ${c.degreesLatitude},${c.degreesLongitude}]`;
  else if (type === 'pollCreationMessage' || type === 'pollCreationMessageV3') out.text = `[סקר: ${c.name || ''}]`;
  else return null;
  if (!out.text && !out.media && !out.note) return null;
  return out;
}

export class WhatsApp {
  /**
   * @param {object} o
   * @param {(status: string) => void} [o.onStatus]  'connecting' | 'qr' | 'open' | 'closed' | 'logged_out'
   * @param {() => void} [o.onLoggedOut]  if set, called instead of exiting the process (the app re-links from the UI)
   */
  constructor({ cfg, state, log, onMessage, inbox, onStatus, onLoggedOut }) {
    Object.assign(this, { cfg, state, log, onMessage, inbox, onStatus, onLoggedOut });
    this.status = 'connecting';
    this.qr = null; // latest QR string while waiting to be linked
    this.me = null; // { id, name } of the linked account
    this.gen = 0; // bumps on every (re)connect so events of an old socket are ignored
    this.watch = makeWatchMatcher(cfg.watchChats || []);
    this.subjects = {}; // group jid -> subject
    this.lidPn = {}; // lid -> pn and pn -> lid
    this.contacts = {}; // jid (pn or lid) -> saved address-book name
    try {
      this.contacts = JSON.parse(fs.readFileSync(paths.contacts, 'utf8'));
    } catch {
      /* first run */
    }
    this.sock = null;
    this.groupJid = cfg.groupJid || state.d.groupJid || '';
    this.open = false;
    this.waiters = [];
    this.seen = new Set([...state.d.processedIds, ...state.d.sentIds]);
    this.retry = 0;
    this.pairingRequested = false;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  async connect({ listGroups = false } = {}) {
    this.listMode = listGroups;
    const gen = ++this.gen;
    this.setStatus('connecting');
    const { state: auth, saveCreds } = await useMultiFileAuthState(paths.waAuth);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* fall back to the bundled default */
    }
    const sock = makeWASocket({
      version,
      auth,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false, // don't steal notifications from the phone
      syncFullHistory: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (gen !== this.gen) return; // an old socket (after relink/reconnect)
      if (u.qr) {
        this.qr = u.qr;
        this.setStatus('qr');
        if (this.cfg.pairingPhone && !this.pairingRequested) {
          this.pairingRequested = true;
          const code = await sock.requestPairingCode(this.cfg.pairingPhone.replace(/\D/g, ''));
          console.log(`\nקוד צימוד: ${code}\nבטלפון: WhatsApp > מכשירים מקושרים > קישור מכשיר > קישור עם מספר טלפון\n`);
        } else if (!this.cfg.pairingPhone && process.stdout.isTTY) {
          console.log('\nסרוק עם WhatsApp: הגדרות > מכשירים מקושרים > קישור מכשיר\n');
          qrcode.generate(u.qr, { small: true });
        }
      }
      if (u.connection === 'open') {
        this.open = true;
        this.everOpened = true;
        this.retry = 0;
        this.qr = null;
        this.me = sock.user ? { id: sock.user.id, name: sock.user.name || sock.user.verifiedName || '' } : null;
        this.setStatus('open');
        this.log.info('WhatsApp connected');
        if (listGroups) return this.printGroups();
        await this.resolveGroup();
        this.waiters.splice(0).forEach((w) => w());
      }
      if (u.connection === 'close') {
        this.open = false;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.setStatus('logged_out');
          if (this.onLoggedOut) {
            this.log.error('WhatsApp logged out - waiting for a new link from the settings page');
            return this.onLoggedOut();
          }
          this.log.error('WhatsApp logged out. Delete data/wa-auth and run start.bat to link again.');
          process.exit(2);
        }
        this.setStatus('closed');
        const delay = Math.min(60, 2 ** this.retry++) * 1000;
        this.log.warn({ code, delay }, 'WhatsApp disconnected, reconnecting');
        setTimeout(() => {
          if (gen === this.gen) this.connect({ listGroups }).catch((e) => this.log.error({ err: e }, 'reconnect failed'));
        }, delay);
      }
    });

    sock.ev.on('contacts.upsert', (cs) => this.addContacts(cs));
    sock.ev.on('contacts.update', (cs) => this.addContacts(cs));
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (lid && pn) Object.assign(this.lidPn, { [lid]: pn, [pn]: lid });
    });
    sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => g.subject && (this.subjects[g.id] = g.subject)));
    sock.ev.on('groups.update', (gs) => gs.forEach((g) => g.subject && (this.subjects[g.id] = g.subject)));
    sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
      this.addContacts(contacts || []);
      // recent history of watched chats is stored as context (older than first run = not "new")
      for (const m of messages || []) this.handleWatched(m).catch(() => {});
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) this.handle(m).catch((e) => this.log.error({ err: e }, 'message handling failed'));
    });
  }

  /** Ask WhatsApp for a pairing code (link with phone number instead of scanning a QR) */
  async requestPairing(phone) {
    const digitsOnly = String(phone || '').replace(/\D/g, '');
    if (digitsOnly.length < 8) throw new Error('phone number looks wrong - use international format, e.g. 972501234567');
    if (!this.sock || this.status !== 'qr') throw new Error('WhatsApp is not waiting for a link right now');
    return this.sock.requestPairingCode(digitsOnly);
  }

  /** Forget the current link (old auth is kept as wa-auth.old-<time>) and start over with a new QR */
  async relink() {
    this.gen++; // ignore everything the old socket still emits
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* already closed */
    }
    this.open = false;
    this.me = null;
    this.groupJid = this.cfg.groupJid || '';
    if (fs.existsSync(paths.waAuth)) fs.renameSync(paths.waAuth, `${paths.waAuth}.old-${Date.now()}`);
    await this.connect({ listGroups: this.listMode });
  }

  /** Close the socket for good (shutdown / before an import replaces data\wa-auth) */
  close() {
    this.gen++;
    this.open = false;
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* already closed */
    }
  }

  /** Group subjects, refreshed from WhatsApp (needs an open connection) */
  async refreshGroups() {
    if (!this.open || !this.sock) return this.subjects;
    const groups = await this.sock.groupFetchAllParticipating();
    for (const g of Object.values(groups)) if (g.subject) this.subjects[g.id] = g.subject;
    return this.subjects;
  }

  /**
   * Groups and saved contacts for the chat picker.
   * @returns {{jid: string, name: string, type: 'group'|'contact', phone?: string}[]}
   */
  listChats({ q = '', type = 'all', limit = 50 } = {}) {
    const needle = normName(q).toLowerCase();
    const qDigits = String(q).replace(/\D/g, '');
    const out = [];
    if (type !== 'contact') {
      for (const [jid, name] of Object.entries(this.subjects)) out.push({ jid, name, type: 'group' });
    }
    if (type !== 'group') {
      const byName = new Map(); // one entry per contact; prefer the phone-number jid over the lid
      for (const [jid, name] of Object.entries(this.contacts)) {
        if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
        const prev = byName.get(name);
        if (!prev || (jid.endsWith('@s.whatsapp.net') && !prev.jid.endsWith('@s.whatsapp.net'))) byName.set(name, { jid, name });
      }
      for (const c of byName.values()) {
        const pn = c.jid.endsWith('@s.whatsapp.net') ? c.jid : this.lidPn[c.jid];
        out.push({ ...c, type: 'contact', phone: pn ? pn.split('@')[0].split(':')[0] : undefined });
      }
    }
    const hits = out.filter(
      (c) => !needle || normName(c.name).toLowerCase().includes(needle) || (qDigits.length >= 3 && (c.phone || '').includes(qDigits)),
    );
    // names that start with the query first, then alphabetical (Hebrew-aware)
    const starts = (c) => (needle && normName(c.name).toLowerCase().startsWith(needle) ? 0 : 1);
    hits.sort((a, b) => starts(a) - starts(b) || a.name.localeCompare(b.name, 'he'));
    return hits.slice(0, limit);
  }

  async printGroups() {
    console.log('ממתין 30 שניות לסנכרון אנשי קשר...');
    await new Promise((r) => setTimeout(r, 30000));
    const groups = await this.sock.groupFetchAllParticipating();
    console.log('\n=== קבוצות ===');
    for (const g of Object.values(groups)) console.log(`  ${g.subject}  →  ${g.id}`);
    console.log('\n=== אנשי קשר עם שם שמור ===');
    const seen = new Set();
    for (const [jid, name] of Object.entries(this.contacts).sort((a, b) => a[1].localeCompare(b[1], 'he'))) {
      if (jid.endsWith('@s.whatsapp.net') || !seen.has(name)) console.log(`  ${name}  →  ${jid}`);
      seen.add(name);
    }
    console.log('\n=== השיחות במעקב (watchChats) ===');
    const groupNames = new Set(Object.values(groups).map((g) => normName(g.subject)));
    const contactNames = new Set(Object.values(this.contacts).map(normName));
    for (const e of this.watch.entries) {
      const ok = e.jid || e.phone || groupNames.has(normName(e.name)) || contactNames.has(normName(e.name));
      console.log(`  ${ok ? '✅' : '❌ לא נמצא – הוסף phone או jid בקונפיג'}  ${e.name}`);
    }
    process.exit(0);
  }

  addContacts(cs) {
    let changed = false;
    for (const c of cs) {
      if (!c?.name) continue;
      for (const j of [c.id, c.lid, c.phoneNumber]) {
        if (j && this.contacts[j] !== c.name) {
          this.contacts[j] = c.name;
          changed = true;
        }
      }
      if (c.lid && c.phoneNumber) Object.assign(this.lidPn, { [c.lid]: c.phoneNumber, [c.phoneNumber]: c.lid });
    }
    if (changed) {
      clearTimeout(this.contactsTimer);
      this.contactsTimer = setTimeout(() => fs.writeFileSync(paths.contacts, JSON.stringify(this.contacts, null, 1)), 3000);
    }
  }

  nameOf(jid) {
    return this.contacts[jid] || this.contacts[this.lidPn[jid]] || '';
  }

  /** Store a message from one of the watched chats in the inbox (scanned hourly) */
  async handleWatched(m) {
    if (!this.inbox || !m?.key?.id || this.listMode) return;
    const jid = m.key.remoteJid;
    if (!jid || jid === this.groupJid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
    const isGroup = jid.endsWith('@g.us');
    if (isGroup && !this.subjects[jid] && this.sock) {
      try {
        this.subjects[jid] = (await this.sock.groupMetadata(jid)).subject;
      } catch {
        return;
      }
    }
    const jids = [jid, m.key.remoteJidAlt, this.lidPn[jid]].filter(Boolean);
    const name = isGroup ? this.subjects[jid] : jids.map((j) => this.nameOf(j)).find(Boolean);
    const key = this.watch.match({ jids, name });
    if (!key) return;

    const ts = toNum(m.messageTimestamp);
    if (ts < Date.now() / 1000 - 7 * 86400) return;
    const c = extractContent(m);
    if (!c) return;
    let sender = 'אני';
    if (!m.key.fromMe) {
      if (!isGroup) sender = key;
      else {
        const p = m.key.participantAlt || m.key.participant;
        sender = this.nameOf(m.key.participant) || this.nameOf(m.key.participantAlt) || m.pushName || (p ? p.split('@')[0] : 'משתתף');
      }
    }
    if (this.inbox.has(key, m.key.id)) return;
    const notes = [c.media === 'image' ? 'תמונה' : c.media === 'document' ? 'מסמך' : '', c.note || ''];
    let mediaFile;
    // Download images/PDFs only for messages that will be reviewed (not old context)
    if (c.media && this.cfg.scanDownloadMedia !== false && ts > this.inbox.chat(key).lastScannedTs) {
      const r = await this.download(m, c);
      mediaFile = r.mediaFile;
      if (r.note) notes.push(r.note);
    }
    const note = notes.filter(Boolean).join(', ');
    const added = this.inbox.add(key, jid, { id: m.key.id, ts, fromMe: Boolean(m.key.fromMe), sender, text: c.text.slice(0, 1500), note: note || undefined, mediaFile });
    if (added) this.log.debug({ chat: key, sender }, 'watched message stored');
  }

  async resolveGroup() {
    const groups = await this.sock.groupFetchAllParticipating();
    for (const g of Object.values(groups)) this.subjects[g.id] = g.subject;
    if (this.groupJid) return;
    const want = (this.cfg.groupName || '').trim();
    if (!want) return this.log.info('No group chosen yet - pick one on the settings page');
    const match = Object.values(groups).filter((g) => (g.subject || '').trim() === want);
    if (match.length === 1) {
      this.groupJid = match[0].id;
      this.state.d.groupJid = this.groupJid;
      this.state.save();
      this.log.info({ jid: this.groupJid }, `Listening to group "${want}"`);
    } else {
      this.log.error(
        { found: match.length, groups: Object.values(groups).map((g) => g.subject) },
        `Group "${want}" not found exactly once. Run "npm run list-groups" and set groupJid in config.json`,
      );
    }
  }

  async handle(m) {
    const id = m.key?.id;
    if (!id) return;
    if (!this.groupJid || m.key.remoteJid !== this.groupJid) return this.handleWatched(m);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.cfg.onlyFromMe && !m.key.fromMe) return;

    const ts = toNum(m.messageTimestamp);
    const minTs = Math.max(this.state.d.lastSeenTs || 0, Date.now() / 1000 - (this.cfg.catchUpMaxHours ?? 72) * 3600);
    if (ts < minTs) return; // same-second duplicates are caught by the seen-id set

    const c = extractContent(m);
    if (!c) return;
    if (c.text.trim().startsWith(this.cfg.botPrefix)) return; // our own reply

    const msg = { id, ts, text: c.text.trim(), note: c.note };
    if (c.media) Object.assign(msg, await this.download(m, c));
    this.log.info({ id, ts, text: msg.text.slice(0, 80), media: Boolean(msg.mediaFile) }, 'new message');
    this.onMessage(msg);
  }

  /** Save an image/PDF to the work folder so Claude can Read it. Returns {mediaFile} or {note} */
  async download(m, c) {
    try {
      const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: this.sock.updateMediaMessage });
      if (buf.length > MAX_MEDIA_BYTES) return { note: 'קובץ גדול מדי' };
      const name = `${m.key.id}.${c.ext}`;
      fs.writeFileSync(path.join(paths.media, name), buf);
      return { mediaFile: `media/${name}` };
    } catch (e) {
      this.log.warn({ err: e }, 'media download failed');
      return { note: 'לא הצלחתי להוריד את הקובץ המצורף' };
    }
  }

  waitOpen(ms = 120000) {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WhatsApp not connected')), ms);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async send(text) {
    await this.waitOpen();
    if (!this.groupJid) throw new Error('group not resolved');
    const messageId = generateMessageID();
    this.seen.add(messageId);
    this.state.d.sentIds.push(messageId);
    this.state.save();
    await this.sock.sendMessage(this.groupJid, { text: `${this.cfg.botPrefix} ${text}` }, { messageId });
  }
}
