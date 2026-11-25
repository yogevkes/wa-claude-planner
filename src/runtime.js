// The running planner: WhatsApp + Google Calendar + Claude + schedules.
// Unlike the old one-shot startup, it stays up while setup is incomplete (so the settings
// page can show a QR, connect Google, pick chats) and applies config changes in place.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import cron from 'node-cron';
import { paths, saveConfigPatch, INSTANCE, ROOT, HOME } from './config.js';
import { State } from './state.js';
import { Calendar, getAuthorizedClient, googleClientFile, parseOAuthClient } from './calendar.js';
import { askClaude, runClaudeCli, resolveClaudePath } from './claude.js';
import { Processor } from './processor.js';
import { WhatsApp } from './whatsapp.js';
import { Inbox } from './inbox.js';
import { makeWatchMatcher } from './names.js';
import { localHour } from './time.js';
import { startGoogleAuth } from './googleAuth.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** Config keys the settings page may change (everything else stays file-only) */
export const EDITABLE_KEYS = [
  'groupName', 'groupJid', 'watchChats', 'userContext', 'timezone', 'calendarId',
  'morningBrief', 'eveningBrief', 'scanCron', 'scanQuietHours', 'defaultReminderMinutes',
  'claudeModel', 'scanDownloadMedia', 'onlyFromMe',
];

const MAX_QUEUED = 200;

/** Map a Claude CLI failure to something the UI can act on */
export function classifyClaudeError(message) {
  const m = String(message || '');
  if (/cannot find the path|not recognized|ENOENT|Could not start Claude CLI|No such file|command not found/i.test(m)) return 'not_installed';
  if (/log ?in|login|api key|authenticat|unauthori[sz]ed|oauth|credentials/i.test(m)) return 'not_logged_in';
  return 'error';
}

export class Planner extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.cfg  merged config (mutated in place on updates, so every component sees changes)
   * @param {object} o.log  pino logger
   * @param {object} [o.deps]  test seams: { WhatsApp, makeCalendar, runClaude, startGoogleAuth }
   */
  constructor({ cfg, log, deps = {} }) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.deps = {
      WhatsApp,
      makeCalendar: (c) => new Calendar(getAuthorizedClient(), c),
      runClaude: runClaudeCli,
      startGoogleAuth,
      ...deps,
    };
    this.state = new State(paths.state);
    if (!this.state.d.lastSeenTs) {
      // First run: don't process old history, only what's written from now on
      this.state.d.lastSeenTs = Math.floor(Date.now() / 1000);
      this.state.save();
    }
    this.inbox = new Inbox(paths.inbox);
    this.processor = null;
    this.calendar = null;
    this.queue = []; // messages that arrived while paused / before Google was connected
    this.crons = [];
    this.google = { state: 'unknown', error: null };
    this.claude = { state: 'unknown', error: null, checkedAt: null, busy: false };
    this.googleFlow = null;
    this.startedAt = new Date();
  }

  get paused() {
    return Boolean(this.state.d.paused);
  }

  async start() {
    this.cleanMedia();
    this.wa = new this.deps.WhatsApp({
      cfg: this.cfg,
      state: this.state,
      log: this.log,
      inbox: this.inbox,
      onMessage: (m) => this.onWhatsAppMessage(m),
      onStatus: (s) => this.emit('change', { whatsapp: s }),
      onLoggedOut: () => this.wa.relink().catch((e) => this.log.error({ err: e }, 'relink failed')),
    });
    await this.wa.connect();
    await this.initCalendar();
    this.schedule();
    this.checkClaude().catch(() => {});

    // After startup, give WhatsApp a few minutes to deliver what arrived while the PC was off, then scan
    this.wa
      .waitOpen(10 * 60000)
      .then(() => setTimeout(() => this.hasWatchChats() && this.run((p) => p.scan()), 3 * 60000))
      .catch(() => {});
    // Computer was off/asleep at brief time? send the morning brief late (until lateMorningBriefUntilHour)
    this.wa
      .waitOpen(10 * 60000)
      .then(() => {
        const morningHour = Number(String(this.cfg.morningBrief || '').split(/\s+/)[1]);
        const h = localHour(new Date(), this.cfg.timezone);
        if (Number.isFinite(morningHour) && h >= morningHour && h < (this.cfg.lateMorningBriefUntilHour ?? 12)) {
          setTimeout(() => this.run((p) => p.brief('morning')), 30000);
        }
      })
      .catch(() => {});
    this.log.info(`wa-claude planner started (instance: ${INSTANCE}, v${VERSION})`);
  }

  cleanMedia() {
    for (const f of fs.readdirSync(paths.media)) {
      const p = path.join(paths.media, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400000) fs.rmSync(p, { force: true });
    }
  }

  // ---------------- Google Calendar ----------------
  async initCalendar() {
    try {
      const calendar = this.deps.makeCalendar(this.cfg);
      await calendar.listWindow(0, 1); // fail fast if auth is broken
      this.calendar = calendar;
      this.google = { state: 'ok', error: null };
      this.makeProcessor();
    } catch (e) {
      this.calendar = null;
      this.google = { state: e.code || (/invalid_grant|unauthori[sz]ed|401/i.test(e.message) ? 'not_authorized' : 'error'), error: e.message };
      this.log.error(`Google Calendar: ${e.message}`);
    }
    this.emit('change', { google: this.google.state });
    return this.google;
  }

  /** Begin the browser consent flow; returns the URL to open */
  async beginGoogleAuth() {
    this.googleFlow?.cancel?.();
    const flow = await this.deps.startGoogleAuth();
    this.googleFlow = flow;
    flow.done
      .then(async ({ calendars }) => {
        this.calendars = calendars;
        this.log.info('Google Calendar connected');
        await this.initCalendar();
      })
      .catch((e) => {
        if (e.message !== 'cancelled') {
          this.google = { state: 'error', error: e.message };
          this.emit('change', { google: 'error' });
        }
      });
    return flow.url;
  }

  /** Save an uploaded OAuth client JSON as this instance's own Google client */
  saveGoogleClient(json) {
    parseOAuthClient(json); // throws a readable error if it's the wrong kind of JSON
    fs.writeFileSync(paths.googleCreds, typeof json === 'string' ? json : JSON.stringify(json, null, 2));
    this.google = { state: 'not_authorized', error: null };
    this.emit('change', { google: this.google.state });
  }

  async listCalendars() {
    if (!this.calendar) return [];
    const res = await this.calendar.api.calendarList.list();
    return (res.data.items || []).map((c) => ({ id: c.id, summary: c.summary, primary: Boolean(c.primary) }));
  }

  // ---------------- message flow ----------------
  makeProcessor() {
    if (this.processor) return;
    this.processor = new Processor({
      cfg: this.cfg,
      state: this.state,
      calendar: this.calendar,
      log: this.log,
      inbox: this.inbox,
      send: (text) => this.wa.send(text),
      ask: (prompt) => askClaude(prompt, this.cfg, this.deps.runClaude, this.log),
    });
    this.drainQueue();
  }

  onWhatsAppMessage(m) {
    if (!this.processor || this.paused) {
      this.queue.push(m);
      if (this.queue.length > MAX_QUEUED) this.queue.shift();
      this.log.info({ queued: this.queue.length }, this.paused ? 'paused - message queued' : 'not ready yet - message queued');
      return;
    }
    this.processor.enqueue(m);
  }

  drainQueue() {
    if (!this.processor || this.paused) return;
    for (const m of this.queue.splice(0)) this.processor.enqueue(m);
  }

  /** Run a processor job unless paused / not ready */
  run(job) {
    if (!this.processor || this.paused) return undefined;
    return this.processor.run(() => job(this.processor));
  }

  setPaused(paused) {
    this.state.d.paused = Boolean(paused);
    this.state.save();
    this.log.info(paused ? 'paused from the settings page' : 'resumed');
    if (!paused) this.drainQueue();
    this.emit('change', { paused: this.paused });
  }

  hasWatchChats() {
    return (this.cfg.watchChats || []).length > 0;
  }

  // ---------------- schedules ----------------
  schedule() {
    for (const t of this.crons.splice(0)) t.stop();
    const tz = this.cfg.timezone;
    const add = (expr, job) => {
      if (!expr) return;
      if (!cron.validate(expr)) return this.log.warn({ expr }, 'invalid cron expression - skipped');
      this.crons.push(cron.schedule(expr, job, { timezone: tz, noOverlap: true }));
    };
    add(this.cfg.morningBrief, () => this.run((p) => p.brief('morning')));
    add(this.cfg.eveningBrief, () => this.run((p) => p.brief('evening')));
    add(this.cfg.scanCron, () => this.hasWatchChats() && this.run((p) => p.scan()));
  }

  // ---------------- config ----------------
  /** Validate + save a config patch from the UI and apply it without restarting */
  updateConfig(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!EDITABLE_KEYS.includes(k)) throw new Error(`setting "${k}" can't be changed here`);
      clean[k] = v;
    }
    if ('watchChats' in clean) {
      if (!Array.isArray(clean.watchChats)) throw new Error('watchChats must be a list');
      clean.watchChats = clean.watchChats
        .map((e) => (typeof e === 'string' ? e.trim() : { name: String(e?.name || '').trim(), ...(e.jid ? { jid: e.jid } : {}), ...(e.phone ? { phone: String(e.phone) } : {}) }))
        .filter((e) => (typeof e === 'string' ? e : e.name));
    }
    for (const k of ['morningBrief', 'eveningBrief', 'scanCron']) {
      if (clean[k] && !cron.validate(clean[k])) throw new Error(`"${clean[k]}" is not a valid schedule`);
    }
    if ('scanQuietHours' in clean) {
      const q = clean.scanQuietHours;
      if (!(Array.isArray(q) && (q.length === 0 || (q.length === 2 && q.every((h) => Number.isInteger(h) && h >= 0 && h <= 23))))) {
        throw new Error('scanQuietHours must be [fromHour, toHour]');
      }
    }
    const before = makeWatchMatcher(this.cfg.watchChats || []);
    saveConfigPatch(clean);
    Object.assign(this.cfg, clean);

    if ('watchChats' in clean && this.wa) {
      this.wa.watch = makeWatchMatcher(this.cfg.watchChats);
      // Newly watched chats start "now": older messages are context, not news
      const now = Math.floor(Date.now() / 1000);
      for (const e of this.wa.watch.entries) {
        if (!before.entries.some((b) => b.name === e.name)) this.inbox.chat(e.name).lastScannedTs = now;
      }
      this.inbox.save();
    }
    if (('groupJid' in clean || 'groupName' in clean) && this.wa) {
      this.wa.groupJid = this.cfg.groupJid || '';
      this.state.d.groupJid = this.wa.groupJid;
      this.state.save();
      if (!this.wa.groupJid && this.wa.open) this.wa.resolveGroup().catch(() => {});
    }
    if (this.calendar && ('calendarId' in clean || 'timezone' in clean)) {
      this.calendar.id = this.cfg.calendarId || 'primary';
      this.calendar.tz = this.cfg.timezone;
    }
    if (['morningBrief', 'eveningBrief', 'scanCron', 'timezone'].some((k) => k in clean)) this.schedule();
    this.log.info({ keys: Object.keys(clean) }, 'settings updated');
    this.emit('change', { config: Object.keys(clean) });
    return this.cfg;
  }

  // ---------------- Claude Code ----------------
  claudeExe() {
    return resolveClaudePath(this.cfg.claudePath);
  }

  async checkClaude() {
    if (this.claude.busy) return this.claude;
    this.claude = { ...this.claude, busy: true };
    try {
      const out = await this.deps.runClaude('Reply with the single word OK.', { ...this.cfg, claudeModel: 'haiku', claudeTimeoutSec: 120 });
      this.claude = { state: 'ok', error: null, checkedAt: Date.now(), busy: false, reply: String(out).slice(0, 40) };
    } catch (e) {
      this.claude = { state: classifyClaudeError(e.message), error: e.message.slice(0, 400), checkedAt: Date.now(), busy: false };
    }
    this.emit('change', { claude: this.claude.state });
    return this.claude;
  }

  /** Install Claude Code with the official installer (Windows, per user, no admin) */
  installClaude() {
    if (process.platform !== 'win32') throw new Error('automatic install is only available on Windows');
    if (this.claude.installing) return;
    this.claude = { ...this.claude, installing: true, installLog: '' };
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], { windowsHide: true });
    const add = (d) => {
      this.claude.installLog = (this.claude.installLog + d.toString()).slice(-4000);
    };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    p.on('close', (code) => {
      this.claude.installing = false;
      this.log.info({ code }, 'Claude Code installer finished');
      this.checkClaude().catch(() => {});
    });
    p.on('error', (e) => {
      this.claude.installing = false;
      add(String(e.message));
    });
  }

  /** Open a console window where the user logs in to Claude Code (needs a signed-in desktop session) */
  openClaudeLogin() {
    if (process.platform !== 'win32') throw new Error('only available on Windows');
    const env = this.cfg.claudeConfigDir ? { ...process.env, CLAUDE_CONFIG_DIR: this.cfg.claudeConfigDir } : process.env;
    spawn('cmd.exe', ['/c', 'start', 'Claude Code login', 'cmd', '/k', this.claudeExe()], { env, detached: true, stdio: 'ignore' }).unref();
  }

  // ---------------- import an older installation ----------------
  /**
   * Copy config.json + data\ (WhatsApp link, Google token, tasks, history) from a folder of a
   * previous installation (e.g. D:\claude\wa-claude). The caller restarts the process afterwards.
   */
  importFrom(dir) {
    const src = path.resolve(String(dir || '').trim().replace(/^"|"$/g, ''));
    const srcData = path.join(src, 'data');
    if (!fs.existsSync(path.join(src, 'config.json')) || !fs.existsSync(srcData)) {
      throw new Error('לא נמצאו config.json ותיקיית data בתיקייה הזו');
    }
    const dstData = path.dirname(paths.state);
    if (path.resolve(srcData) === path.resolve(dstData)) throw new Error('זו התיקייה של ההתקנה הנוכחית');
    fs.copyFileSync(path.join(src, 'config.json'), paths.config);
    for (const name of ['wa-auth', 'google-token.json', 'google-credentials.json', 'state.json', 'inbox.json', 'contacts.json']) {
      const from = path.join(srcData, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(dstData, name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    }
    this.log.info({ from: src }, 'imported an existing installation - restarting');
  }

  // ---------------- status for the UI / tray ----------------
  status() {
    const wa = this.wa || {};
    const groupJid = wa.groupJid || '';
    const google = { ...this.google, hasClient: Boolean(googleClientFile()), ownClient: fs.existsSync(paths.googleCreds) };
    const claude = { state: this.claude.state, error: this.claude.error, checkedAt: this.claude.checkedAt, busy: this.claude.busy, installing: Boolean(this.claude.installing), installLog: this.claude.installLog };
    const whatsapp = { status: wa.status || 'connecting', me: wa.me || null };
    const group = { jid: groupJid, name: (groupJid && wa.subjects?.[groupJid]) || this.cfg.groupName || '' };
    const c = this.cfg;
    return {
      version: VERSION,
      instance: INSTANCE,
      platform: process.platform,
      dataDir: path.dirname(paths.state),
      home: HOME,
      startedAt: this.startedAt.toISOString(),
      paused: this.paused,
      queued: this.queue.length,
      whatsapp,
      group,
      google,
      claude,
      setupComplete: whatsapp.status === 'open' && Boolean(groupJid) && google.state === 'ok' && claude.state === 'ok',
      config: Object.fromEntries(EDITABLE_KEYS.map((k) => [k, c[k]])),
    };
  }

  async sendTest() {
    if (!this.wa?.groupJid) throw new Error('עוד לא נבחרה קבוצה');
    await this.wa.send('בדיקה: WA-Claude Planner מחובר ומאזין לקבוצה הזו. כתוב כאן מה שתרצה לתכנן.');
  }

  async stop() {
    for (const t of this.crons.splice(0)) t.stop();
    await this.processor?.flush();
    this.inbox?.save();
    this.googleFlow?.cancel?.();
  }
}
