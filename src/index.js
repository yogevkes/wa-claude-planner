import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import cron from 'node-cron';
import { loadConfig, paths } from './config.js';
import { State } from './state.js';
import { Calendar, getAuthorizedClient } from './calendar.js';
import { askClaude, runClaudeCli } from './claude.js';
import { Processor } from './processor.js';
import { WhatsApp } from './whatsapp.js';
import { localHour } from './time.js';
import { Inbox } from './inbox.js';

const listGroups = process.argv.includes('--list-groups') || process.argv.includes('--list-chats');
const cfg = loadConfig();
// Human-readable console + JSON log file
const LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const consoleStream = {
  write(line) {
    try {
      const { level, time, msg, pid, hostname, err, ...rest } = JSON.parse(line);
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      const ts = new Date(time).toLocaleString('he-IL', { timeZone: cfg.timezone });
      process.stdout.write(`[${ts}] ${LEVELS[level] || level} ${msg || ''}${extra}${err ? ` ${err.message}` : ''}\n`);
    } catch {
      process.stdout.write(line);
    }
  },
};
const log = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream([
    { stream: consoleStream },
    { stream: pino.destination({ dest: path.join(paths.logs, 'app.log'), mkdir: true, sync: true }) },
  ]),
);

const state = new State(paths.state);
if (!state.d.lastSeenTs) {
  // First run: don't process old history, only what's written from now on
  state.d.lastSeenTs = Math.floor(Date.now() / 1000);
  state.save();
}

// Clean up downloaded media older than 7 days
for (const f of fs.readdirSync(paths.media)) {
  const p = path.join(paths.media, f);
  if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400000) fs.rmSync(p, { force: true });
}

const inbox = !listGroups && (cfg.watchChats || []).length ? new Inbox(paths.inbox) : null;

let processor;
if (!listGroups) {
  let calendar;
  try {
    calendar = new Calendar(getAuthorizedClient(), cfg);
    await calendar.listWindow(0, 1); // fail fast if auth is broken
  } catch (e) {
    log.error(`Google Calendar: ${e.message}`);
    process.exit(1);
  }
  processor = new Processor({
    cfg,
    state,
    calendar,
    log,
    inbox,
    send: (text) => wa.send(text),
    ask: (prompt) => askClaude(prompt, cfg, runClaudeCli, log),
  });
}

const wa = new WhatsApp({ cfg, state, log, inbox, onMessage: (m) => processor.enqueue(m) });
await wa.connect({ listGroups });

if (!listGroups) {
  const tz = cfg.timezone;
  if (cfg.morningBrief) cron.schedule(cfg.morningBrief, () => processor.run(() => processor.brief('morning')), { timezone: tz, noOverlap: true });
  if (cfg.eveningBrief) cron.schedule(cfg.eveningBrief, () => processor.run(() => processor.brief('evening')), { timezone: tz, noOverlap: true });

  if (inbox && cfg.scanCron) {
    cron.schedule(cfg.scanCron, () => processor.run(() => processor.scan()), { timezone: tz, noOverlap: true });
    // After startup, give WhatsApp a few minutes to deliver messages received while the PC was off, then check
    wa.waitOpen(10 * 60000)
      .then(() => setTimeout(() => processor.run(() => processor.scan()), 3 * 60000))
      .catch(() => {});
  }

  // Computer was off/asleep at brief time? send the morning brief late (until lateMorningBriefUntilHour)
  wa.waitOpen(10 * 60000)
    .then(() => {
      const morningHour = Number(String(cfg.morningBrief || '').split(/\s+/)[1]);
      const h = localHour(new Date(), tz);
      if (Number.isFinite(morningHour) && h >= morningHour && h < (cfg.lateMorningBriefUntilHour ?? 12)) {
        setTimeout(() => processor.run(() => processor.brief('morning')), 30000);
      }
    })
    .catch(() => {});

  const shutdown = async () => {
    log.info('shutting down');
    await processor.flush();
    inbox?.save();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log.info('wa-claude planner started');
}
