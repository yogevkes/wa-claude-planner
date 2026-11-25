import path from 'node:path';
import pino from 'pino';
import { loadConfig, paths, INSTANCE, IS_DEFAULT } from './config.js';
import { State } from './state.js';
import { WhatsApp } from './whatsapp.js';
import { Planner } from './runtime.js';
import { createServer, listen } from './server.js';

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

if (listGroups) {
  // Console helper: print groups / contacts / watch-list matches and exit
  const wa = new WhatsApp({ cfg, state: new State(paths.state), log, inbox: null, onMessage: () => {} });
  await wa.connect({ listGroups: true });
} else {
  const port = Number(process.env.WA_CLAUDE_PORT || cfg.uiPort || (IS_DEFAULT ? 3777 : 0));
  const planner = new Planner({ cfg, log });
  const server = createServer(planner, { port });
  try {
    await listen(server, port);
  } catch (e) {
    log.error(e.message);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${server.address().port}`;
  log.info(`settings page: ${url}`);
  if (process.stdout.isTTY) console.log(`\nהגדרות: ${url}\n`);
  await planner.start();

  const shutdown = async () => {
    log.info('shutting down');
    await planner.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => log.error({ err: e }, 'unhandled rejection'));
  log.info(`instance: ${INSTANCE}`);
}
