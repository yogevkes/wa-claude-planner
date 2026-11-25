// UI demo / development server: the real settings server and runtime with fake WhatsApp,
// Google and Claude, so the wizard can be clicked through without linking anything.
//   node scripts/demo-ui.js            -> http://127.0.0.1:3790 (fresh setup)
//   node scripts/demo-ui.js --ready    -> everything already connected (dashboard)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ready = process.argv.includes('--ready');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-demo-'));
process.env.WA_CLAUDE_DATA = path.join(tmp, 'data');
process.env.WA_CLAUDE_CONFIG = path.join(tmp, 'config.json');

const { loadConfig } = await import('../src/config.js');
const { Planner } = await import('../src/runtime.js');
const { createServer, listen } = await import('../src/server.js');
const { WhatsApp } = await import('../src/whatsapp.js');
const { GoogleSetupError } = await import('../src/calendar.js');

const log = { info: (...a) => console.log('[info]', ...a.filter((x) => typeof x === 'string')), warn() {}, error() {}, debug() {} };
fs.mkdirSync(path.join(tmp, 'data', 'logs'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'data', 'google-credentials.json'), JSON.stringify({ installed: { client_id: 'demo', client_secret: 'demo' } }));
fs.writeFileSync(
  path.join(tmp, 'data', 'logs', 'app.log'),
  [
    [30, 'wa-claude planner started (instance: default, v2.0.0)'],
    [30, 'WhatsApp connected'],
    [30, 'new message'],
    [30, 'processing batch'],
    [40, 'WhatsApp disconnected, reconnecting'],
    [30, 'scanning watched chats'],
  ]
    .map(([level, msg], i) => JSON.stringify({ level, time: Date.now() - (6 - i) * 600000, msg }))
    .join('\n') + '\n',
);

let googleOk = ready;
class DemoWA extends WhatsApp {
  async connect() {
    this.subjects = { 'g1@g.us': 'קבוצה שלי עם עצמי', 'g2@g.us': 'המשפחה- קבוצה', 'g3@g.us': 'ועד הבית', 'g4@g.us': 'חוג אימפרוביזציה' };
    this.contacts = {
      '972501111111@s.whatsapp.net': 'אמא', '972502222222@s.whatsapp.net': 'רוני', '972503333333@s.whatsapp.net': 'יולי 🐣',
      '972504444444@s.whatsapp.net': 'אורי', '972505555555@s.whatsapp.net': 'עו"ד חן אורמן', '972506666666@s.whatsapp.net': 'יותם',
    };
    if (ready) return this.linkNow();
    this.qr = '2@demo-qr-' + Date.now();
    this.setStatus('qr');
    setTimeout(() => this.linkNow(), 25000); // "scanned" after 25s
  }
  linkNow() {
    this.qr = null;
    this.open = true;
    this.everOpened = true;
    this.me = { id: '972500000000@s.whatsapp.net', name: 'Yogi' };
    this.setStatus('open');
  }
  async refreshGroups() {
    return this.subjects;
  }
  async relink() {
    this.open = false;
    await this.connect();
  }
  async requestPairing() {
    return 'K3P9-7QXA';
  }
  async resolveGroup() {}
  async send(t) {
    console.log('[send]', t);
  }
  waitOpen() {
    return new Promise(() => {});
  }
}

const cfg = loadConfig();
if (ready) Object.assign(cfg, { groupJid: 'g1@g.us', watchChats: [{ name: 'רוני', jid: '972502222222@s.whatsapp.net' }, { name: 'המשפחה- קבוצה', jid: 'g2@g.us' }] });
const planner = new Planner({
  cfg,
  log,
  deps: {
    WhatsApp: DemoWA,
    runClaude: async () => {
      await new Promise((r) => setTimeout(r, 1200));
      return 'OK';
    },
    makeCalendar: (c) => {
      if (!googleOk) throw new GoogleSetupError('not_authorized', 'Google is not authorized yet');
      return { cfg: c, listWindow: async () => [], api: { calendarList: { list: async () => ({ data: { items: [{ id: 'primary', summary: 'yogi@gmail.com', primary: true }, { id: 'fam@group.calendar.google.com', summary: 'משפחה' }] } }) } } };
    },
    startGoogleAuth: async () => ({
      url: 'about:blank#google-consent-demo',
      done: new Promise((r) => setTimeout(() => { googleOk = true; r({ calendars: [] }); }, 3000)),
      cancel() {},
    }),
  },
});
if (ready) planner.state.d.groupJid = 'g1@g.us';
const port = Number(process.env.PORT || 3790);
await listen(createServer(planner, { port, exit: () => console.log('[exit requested]') }), port);
await planner.start();
console.log(`demo UI: http://127.0.0.1:${port}`);
