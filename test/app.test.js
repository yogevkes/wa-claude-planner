import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-app-'));
process.env.WA_CLAUDE_DATA = path.join(tmp, 'data');
process.env.WA_CLAUDE_CONFIG = path.join(tmp, 'config.json');

const { loadConfig, paths } = await import('../src/config.js');
const { Planner, classifyClaudeError } = await import('../src/runtime.js');
const { createServer, listen, tailLog, EXIT_RESTART } = await import('../src/server.js');
const { WhatsApp } = await import('../src/whatsapp.js');
const { GoogleSetupError } = await import('../src/calendar.js');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

class FakeWA {
  constructor(o) {
    Object.assign(this, o);
    this.status = 'connecting';
    this.qr = null;
    this.subjects = { 'g1@g.us': 'קבוצה שלי עם עצמי', 'g2@g.us': 'המשפחה' };
    this.groupJid = o.cfg.groupJid || '';
    this.sent = [];
    this.watch = { entries: [] };
  }
  async connect() {
    this.qr = '2@fake-qr-payload';
    this.status = 'qr';
    this.onStatus?.('qr');
  }
  link() {
    this.qr = null;
    this.status = 'open';
    this.open = true;
    this.me = { id: '972500000000@s.whatsapp.net', name: 'Yogi' };
  }
  waitOpen() {
    return new Promise(() => {});
  }
  async send(t) {
    this.sent.push(t);
  }
  async relink() {
    this.relinked = true;
  }
  async requestPairing(phone) {
    return `CODE-${phone}`;
  }
  async refreshGroups() {
    return this.subjects;
  }
  listChats({ q }) {
    return Object.entries(this.subjects)
      .filter(([, n]) => n.includes(q))
      .map(([jid, name]) => ({ jid, name, type: 'group' }));
  }
  async resolveGroup() {}
}

function makePlanner({ googleOk = false, claude = async () => 'OK' } = {}) {
  const cfg = { ...loadConfig(), debounceSec: 30 };
  let authorized = googleOk;
  let release;
  const planner = new Planner({
    cfg,
    log: quietLog,
    deps: {
      WhatsApp: FakeWA,
      runClaude: claude,
      makeCalendar: () => {
        if (!authorized) throw new GoogleSetupError('not_authorized', 'Google is not authorized yet');
        return {
          cfg,
          listWindow: async () => [],
          api: { calendarList: { list: async () => ({ data: { items: [{ id: 'primary', summary: 'Yogi', primary: true }] } }) } },
        };
      },
      startGoogleAuth: async () => ({
        url: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1',
        done: new Promise((r) => (release = r)),
        cancel() {},
      }),
    },
  });
  return { planner, cfg, authorize: () => (authorized = true), approveGoogle: () => release({ calendars: [] }) };
}

async function serve(planner, exitCodes = []) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const server = createServer(planner, { port, exit: (c) => exitCodes.push(c) });
  await listen(server, port);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: method === 'GET' ? headers : { 'content-type': 'application/json', 'x-wa-planner': '1', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, base, api, port };
}

test('setup flow: QR -> Google -> group -> complete, through the HTTP API', async () => {
  const { planner, authorize, approveGoogle } = makePlanner();
  await planner.start();
  const { server, api } = await serve(planner);
  try {
    let st = (await api('GET', '/api/status')).body;
    assert.equal(st.whatsapp.status, 'qr');
    assert.equal(st.google.state, 'not_authorized');
    assert.equal(st.setupComplete, false);

    const qr = (await api('GET', '/api/whatsapp/qr')).body;
    assert.match(qr.svg, /^<svg/);
    assert.equal((await api('POST', '/api/whatsapp/pair', { phone: '972501234567' })).body.code, 'CODE-972501234567');

    planner.wa.link();
    const { url } = (await api('POST', '/api/google/auth')).body;
    assert.match(url, /accounts\.google\.com/);
    authorize();
    approveGoogle();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(planner.google.state, 'ok');

    const chats = (await api('GET', '/api/chats?q=' + encodeURIComponent('עצמי'))).body.chats;
    assert.deepEqual(chats.map((c) => c.jid), ['g1@g.us']);

    st = (await api('PUT', '/api/config', { groupJid: 'g1@g.us', groupName: 'קבוצה שלי עם עצמי', watchChats: [{ name: 'המשפחה', jid: 'g2@g.us' }, '  ', 'אמא'] })).body;
    assert.equal(st.group.jid, 'g1@g.us');
    assert.equal(st.group.name, 'קבוצה שלי עם עצמי');
    assert.equal(st.claude.state, 'ok');
    assert.equal(st.setupComplete, true);
    // saved to config.json, applied to the running WhatsApp matcher, and empty entries dropped
    const saved = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    assert.deepEqual(saved.watchChats, [{ name: 'המשפחה', jid: 'g2@g.us' }, 'אמא']);
    assert.equal(planner.wa.watch.match({ jids: ['g2@g.us'] }), 'המשפחה');
    assert.equal(planner.wa.groupJid, 'g1@g.us');

    await api('POST', '/api/test-message');
    assert.equal(planner.wa.sent.length, 1);
  } finally {
    server.close();
    await planner.stop();
  }
});

test('API refuses other hosts, cross-site posts and bad input', async () => {
  const { planner } = makePlanner();
  await planner.start();
  const { server, api, port } = await serve(planner);
  try {
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends Host: evil.example (fetch can't fake Host)
    const rebind = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { host: `evil.example:${port}` } }, (r) => resolve(r.statusCode)).on('error', reject);
    });
    assert.equal(rebind, 403);
    const noHeader = await fetch(`http://127.0.0.1:${port}/api/pause`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"paused":true}' });
    assert.equal(noHeader.status, 403); // a plain cross-site form/fetch can't add the custom header
    assert.equal((await api('POST', '/api/pause', { paused: true }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(planner.paused, false);
    assert.equal((await api('PUT', '/api/config', { claudePath: 'C:\\evil.exe' })).status, 400); // not editable
    assert.equal((await api('PUT', '/api/config', { morningBrief: 'every morning' })).status, 400);
    assert.equal((await api('PUT', '/api/config', { scanQuietHours: [25, 7] })).status, 400);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /WA-Claude Planner/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/..%2Fpackage.json`)).status, 404); // no path traversal
  } finally {
    server.close();
    await planner.stop();
  }
});

test('messages wait while Google is not connected or paused, then go through', async () => {
  const { planner, authorize } = makePlanner();
  await planner.start();
  planner.onWhatsAppMessage({ id: 'm1', ts: 1, text: 'פגישה מחר' });
  assert.equal(planner.queue.length, 1);
  authorize();
  await planner.initCalendar();
  assert.equal(planner.queue.length, 0);
  assert.equal(planner.processor.pending.length, 1);

  planner.setPaused(true);
  planner.onWhatsAppMessage({ id: 'm2', ts: 2, text: 'עוד אחת' });
  assert.equal(planner.queue.length, 1);
  planner.setPaused(false);
  assert.equal(planner.queue.length, 0);
  assert.equal(planner.processor.pending.length, 2);
  await planner.stop();
});

test('Claude check classifies the usual failures', async () => {
  assert.equal(classifyClaudeError('Claude CLI exited 1. stderr: The system cannot find the path specified.'), 'not_installed');
  assert.equal(classifyClaudeError("'claude' is not recognized as an internal or external command"), 'not_installed');
  assert.equal(classifyClaudeError('Claude error: Invalid API key · Please run /login'), 'not_logged_in');
  assert.equal(classifyClaudeError('Claude timed out after 120s'), 'error');
  const { planner } = makePlanner({ claude: async () => { throw new Error('Invalid API key · Please run /login'); } });
  assert.equal((await planner.checkClaude()).state, 'not_logged_in');
});

test('import copies config + data from an older installation and asks for a restart', async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-old-'));
  fs.mkdirSync(path.join(old, 'data', 'wa-auth'), { recursive: true });
  fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify({ groupName: 'ישנה', claudePath: 'C:\\Users\\Yogi\\.local\\bin\\claude.exe' }));
  fs.writeFileSync(path.join(old, 'data', 'wa-auth', 'creds.json'), '{"me":1}');
  fs.writeFileSync(path.join(old, 'data', 'google-token.json'), '{"refresh_token":"x"}');
  const { planner } = makePlanner();
  await planner.start();
  const codes = [];
  const { server, api } = await serve(planner, codes);
  try {
    assert.equal((await api('POST', '/api/import', { path: path.join(os.tmpdir(), 'nope-' + Date.now()) })).status, 400);
    const r = await api('POST', '/api/import', { path: `"${old}"` });
    assert.equal(r.body.restarting, true);
    await new Promise((res) => setTimeout(res, 400));
    assert.deepEqual(codes, [EXIT_RESTART]);
    assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).groupName, 'ישנה');
    assert.equal(fs.readFileSync(path.join(paths.waAuth, 'creds.json'), 'utf8'), '{"me":1}');
    assert.ok(fs.existsSync(paths.googleToken));
  } finally {
    server.close();
  }
});

test('chat picker search: groups + contacts, Hebrew, phone digits, one entry per person', () => {
  const wa = new WhatsApp({ cfg: { watchChats: [] }, state: { d: { processedIds: [], sentIds: [] } }, log: quietLog, onMessage() {} });
  wa.subjects = { 'a@g.us': 'המשפחה- קבוצה', 'b@g.us': 'ועד בית' };
  wa.contacts = { '972501111111@s.whatsapp.net': 'אמא', '123@lid': 'אמא', '972502222222@s.whatsapp.net': 'רוני', '999@lid': 'אורי', 'x@g.us': 'לא איש קשר' };
  wa.lidPn = { '999@lid': '972503333333@s.whatsapp.net' };
  const all = wa.listChats();
  assert.equal(all.filter((c) => c.name === 'אמא').length, 1);
  assert.equal(all.find((c) => c.name === 'אמא').jid, '972501111111@s.whatsapp.net');
  assert.equal(all.find((c) => c.name === 'אורי').phone, '972503333333');
  assert.ok(!all.some((c) => c.name === 'לא איש קשר'));
  assert.deepEqual(wa.listChats({ q: 'משפ' }).map((c) => c.jid), ['a@g.us']);
  assert.deepEqual(wa.listChats({ q: '2222' }).map((c) => c.name), ['רוני']);
  assert.ok(wa.listChats({ type: 'group' }).every((c) => c.type === 'group'));
  // names starting with the query come first
  wa.subjects['c@g.us'] = 'בית ספר';
  assert.equal(wa.listChats({ q: 'בית', type: 'group' })[0].name, 'בית ספר');
});

test('tailLog parses pino lines and tolerates junk', () => {
  const f = path.join(tmp, 'x.log');
  fs.writeFileSync(f, `${JSON.stringify({ level: 30, time: 1, msg: 'a' })}\nnot json\n${JSON.stringify({ level: 50, time: 2, msg: 'b', err: { message: 'boom' } })}\n`);
  const lines = tailLog(f, 2);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].err, 'boom');
});
