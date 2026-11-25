import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-claude-'));
process.env.WA_CLAUDE_DATA = tmp;
process.env.WA_CLAUDE_CONFIG = path.join(tmp, 'config.json');

const { loadConfig, paths } = await import('../src/config.js');
const { State } = await import('../src/state.js');
const { Processor } = await import('../src/processor.js');
const { buildTimeFields, Calendar, addMinutes } = await import('../src/calendar.js');
const claudeMod = await import('../src/claude.js');
const { extractJson, askClaude, runClaudeCli } = claudeMod;
const { buildMessagePrompt } = await import('../src/prompts.js');
const { extractContent } = await import('../src/whatsapp.js');
const { fmtWhen } = await import('../src/format.js');

const cfg = { ...loadConfig(), debounceSec: 0 };

// ---------------- in-memory Google Calendar API fake ----------------
function fakeCalendarApi() {
  const store = new Map();
  let n = 0;
  const api = {
    store,
    events: {
      list: async () => ({ data: { items: [...store.values()] } }),
      get: async ({ eventId }) => {
        if (!store.has(eventId)) throw new Error('404');
        return { data: structuredClone(store.get(eventId)) };
      },
      insert: async ({ requestBody }) => {
        const ev = { id: `ev${++n}`, status: 'confirmed', ...structuredClone(requestBody) };
        store.set(ev.id, ev);
        return { data: ev };
      },
      patch: async ({ eventId, requestBody }) => {
        const ev = { ...store.get(eventId), ...structuredClone(requestBody) };
        store.set(eventId, ev);
        return { data: ev };
      },
      delete: async ({ eventId }) => {
        store.delete(eventId);
        return {};
      },
    },
  };
  return api;
}

function makeCalendar(extra = {}) {
  const cal = Object.create(Calendar.prototype);
  cal.cfg = { ...cfg, ...extra };
  cal.id = 'primary';
  cal.tz = cfg.timezone;
  cal.api = fakeCalendarApi();
  return cal;
}

function makeProcessor(decisions, calOpts) {
  const state = new State(path.join(tmp, `state-${Math.random()}.json`));
  const calendar = makeCalendar(calOpts);
  const sent = [];
  const prompts = [];
  const queue = [...decisions];
  const p = new Processor({
    cfg,
    state,
    calendar,
    send: async (t) => sent.push(t),
    ask: async (prompt) => {
      prompts.push(prompt);
      const d = queue.shift();
      if (d instanceof Error) throw d;
      return { calendar_actions: [], task_actions: [], reply: null, ...d };
    },
  });
  return { p, state, calendar, sent, prompts };
}

const msg = (text, extra = {}) => ({ id: `m${Math.random()}`, ts: Math.floor(Date.now() / 1000), text, ...extra });

// ---------------- tests ----------------
test('buildTimeFields: timed event defaults to 1h and default reminder', () => {
  const f = buildTimeFields({ start: '2026-11-25T10:00' }, 'Asia/Jerusalem', 30);
  assert.deepEqual(f.start, { dateTime: '2026-11-25T10:00:00', timeZone: 'Asia/Jerusalem' });
  assert.deepEqual(f.end, { dateTime: '2026-11-25T11:00:00', timeZone: 'Asia/Jerusalem' });
  assert.equal(f.reminders.overrides[0].minutes, 30);
});

test('buildTimeFields: all-day inclusive end becomes exclusive', () => {
  const f = buildTimeFields({ start: '2026-12-24', end: '2026-12-26', all_day: true }, 'Asia/Jerusalem', 30);
  assert.deepEqual(f.start, { date: '2026-12-24' });
  assert.deepEqual(f.end, { date: '2026-12-27' });
  assert.equal(f.reminders, undefined);
});

test('buildTimeFields: timed event without time throws', () => {
  assert.throws(() => buildTimeFields({ start: '2026-11-25', all_day: false }, 'Asia/Jerusalem', 30));
});

test('addMinutes crosses midnight', () => {
  assert.equal(addMinutes('2026-11-25T23:30', 90), '2026-11-26T01:00:00');
});

test('fmtWhen formats Hebrew day labels', () => {
  assert.equal(fmtWhen({ start: '2026-11-24T10:00', end: '2026-11-24T11:30' }), 'יום ג׳ 24.11 10:00–11:30');
  assert.equal(fmtWhen({ start: '2026-12-24', end: '2026-12-26', all_day: true }), 'יום ה׳ 24.12 עד יום ש׳ 26.12 (כל היום)');
});

test('extractJson tolerates fences and chatter', () => {
  assert.deepEqual(extractJson('sure!\n```json\n{"reply":"היי","calendar_actions":[]}\n```'), { reply: 'היי', calendar_actions: [] });
  assert.throws(() => extractJson('no json here'));
});

test('askClaude retries once on bad JSON', async () => {
  let calls = 0;
  const runner = async () => (++calls === 1 ? 'oops' : '{"reply":"ok"}');
  const d = await askClaude('p', cfg, runner);
  assert.equal(calls, 2);
  assert.equal(d.reply, 'ok');
  assert.deepEqual(d.calendar_actions, []);
});

test('processor: create event + task, confirmations, history, prompt content', async () => {
  const { p, calendar, sent, prompts, state } = makeProcessor([
    {
      calendar_actions: [{ op: 'create', summary: 'רופא שיניים', start: '2026-11-24T10:00', end: null, location: 'חיפה' }],
      task_actions: [{ op: 'add', text: 'להתקשר לאינסטלטור', due: '2026-11-23' }],
      reply: 'שים לב: יש לך עוד פגישה באותו בוקר.',
    },
  ]);
  p.enqueue(msg('ביום שלישי ב-10 רופא שיניים בחיפה, ולהתקשר מחר לאינסטלטור'));
  await p.flush();
  assert.equal(calendar.api.store.size, 1);
  const ev = [...calendar.api.store.values()][0];
  assert.equal(ev.extendedProperties.private.waClaude, '1');
  assert.equal(ev.location, 'חיפה');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /שים לב/);
  assert.match(sent[0], /✅ נוסף ליומן: \*רופא שיניים\* – יום ג׳ 24\.11 10:00–11:00/);
  assert.match(sent[0], /📝 משימה: להתקשר לאינסטלטור/);
  assert.match(prompts[0], /רופא שיניים בחיפה/);
  assert.match(prompts[0], /\(היום\)/);
  assert.equal(state.d.tasks.length, 1);
  assert.equal(state.d.history.length, 2);
  assert.equal(state.d.undoStack.length, 1);
});

test('processor: update keeps duration, then /בטל restores', async () => {
  const { p, calendar, sent } = makeProcessor([
    { calendar_actions: [{ op: 'create', summary: 'פגישה', start: '2026-11-24T10:00', end: '2026-11-24T10:30' }] },
    { calendar_actions: [{ op: 'update', event_id: 'ev1', changes: { start: '2026-11-25T16:00' } }] },
  ]);
  p.enqueue(msg('פגישה ביום שלישי 10:00 חצי שעה'));
  await p.flush();
  p.enqueue(msg('תזיז את הפגישה לרביעי ב-4'));
  await p.flush();
  let ev = calendar.api.store.get('ev1');
  assert.equal(ev.start.dateTime, '2026-11-25T16:00:00');
  assert.equal(ev.end.dateTime, '2026-11-25T16:30:00');
  assert.match(sent[1], /✏️ עודכן: \*פגישה\* → יום ד׳ 25\.11 16:00–16:30/);

  p.enqueue(msg('/בטל'));
  await p.chain;
  ev = calendar.api.store.get('ev1');
  assert.equal(ev.start.dateTime, '2026-11-24T10:00:00');
  assert.match(sent[2], /↩️ בוטל/);
});

test('processor: delete + undo recreates; task done + undo', async () => {
  const { p, calendar, state } = makeProcessor([
    { calendar_actions: [{ op: 'create', summary: 'יום הולדת', start: '2026-12-01', all_day: true }], task_actions: [{ op: 'add', text: 'לקנות מתנה' }] },
    { calendar_actions: [{ op: 'delete', event_id: 'ev1' }], task_actions: [{ op: 'done', id: 1 }] },
  ]);
  p.enqueue(msg('יום הולדת ב-1.12, לקנות מתנה'));
  await p.flush();
  p.enqueue(msg('בוטל, והמתנה נקנתה'));
  await p.flush();
  assert.equal(calendar.api.store.size, 0);
  assert.equal(state.d.tasks[0].done, true);
  p.enqueue(msg('/undo'));
  await p.chain;
  assert.equal(calendar.api.store.size, 1);
  assert.equal([...calendar.api.store.values()][0].summary, 'יום הולדת');
  assert.equal(state.d.tasks[0].done, false);
});

test('processor: protectNonBotEvents blocks edits to manual events', async () => {
  const { p, calendar, sent } = makeProcessor([{ calendar_actions: [{ op: 'delete', event_id: 'ev1' }] }], { protectNonBotEvents: true });
  await calendar.api.events.insert({ requestBody: { summary: 'ידני', start: { date: '2026-12-01' }, end: { date: '2026-12-02' } } });
  p.enqueue(msg('תמחק את האירוע'));
  await p.flush();
  assert.equal(calendar.api.store.size, 1);
  assert.match(sent[0], /⚠️ לא הצלחתי/);
});

test('processor: Claude failure -> warning, /שוב retries', async () => {
  const { p, sent, state } = makeProcessor([new Error('Claude timed out'), { reply: 'עכשיו עבד' }]);
  p.enqueue(msg('משהו'));
  await p.flush();
  assert.match(sent[0], /⚠️ לא הצלחתי לעבד/);
  assert.ok(state.d.failedBatch);
  p.enqueue(msg('/שוב'));
  await p.chain;
  assert.match(sent[1], /עכשיו עבד/);
  assert.equal(state.d.failedBatch, null);
});

test('processor: rapid messages are batched into one Claude call', async () => {
  const { p, prompts } = makeProcessor([{ reply: 'ok' }]);
  p.enqueue(msg('ראשונה'));
  p.enqueue(msg('שנייה'));
  await p.flush();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /ראשונה[\s\S]*שנייה/);
});

test('processor: /משימות lists tasks without calling Claude; brief sends once per day', async () => {
  const { p, sent, prompts } = makeProcessor([{ reply: 'בוקר טוב! היום: ...' }]);
  p.enqueue(msg('/משימות'));
  await p.chain;
  assert.equal(prompts.length, 0);
  assert.match(sent[0], /אין משימות פתוחות/);
  await p.brief('morning');
  await p.brief('morning'); // second scheduled call same day is skipped
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /MORNING BRIEF/);
  assert.match(sent[1], /בוקר טוב/);
});

test('evening brief includes today recap with tasks completed today', async () => {
  const { p, prompts } = makeProcessor([{ task_actions: [{ op: 'add', text: 'לשלם ארנונה' }] }, { task_actions: [{ op: 'done', id: 1 }] }, { reply: 'סיכום' }]);
  p.enqueue(msg('לשלם ארנונה'));
  await p.flush();
  p.enqueue(msg('שילמתי ארנונה'));
  await p.flush();
  await p.brief('evening', true);
  assert.match(prompts[2], /END-OF-DAY SUMMARY/);
  assert.match(prompts[2], /Tasks completed today:\n• לשלם ארנונה/);
});

test('extractContent handles text, captions, pdf, voice, reactions', () => {
  assert.equal(extractContent({ message: { conversation: 'שלום' } }).text, 'שלום');
  assert.equal(extractContent({ message: { extendedTextMessage: { text: 'קישור' } } }).text, 'קישור');
  const img = extractContent({ message: { imageMessage: { caption: 'הזמנה', mimetype: 'image/jpeg' } } });
  assert.equal(img.media, 'image');
  assert.equal(img.text, 'הזמנה');
  const pdf = extractContent({ message: { documentMessage: { fileName: 'תור.pdf', mimetype: 'application/pdf' } } });
  assert.equal(pdf.ext, 'pdf');
  assert.match(extractContent({ message: { audioMessage: {} } }).note, /קולית/);
  assert.equal(extractContent({ message: { reactionMessage: { text: '👍' } } }), null);
  assert.equal(extractContent({ message: { ephemeralMessage: { message: { conversation: 'זמני' } } } }).text, 'זמני');
});

test('runClaudeCli passes Hebrew prompt via stdin and parses CLI JSON', async () => {
  const fake = path.join(tmp, 'fake-claude.mjs');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{ const args=process.argv.slice(2).join(' ');
 process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({reply:'קיבלתי: '+s.trim(), args})})); });`,
  );
  fs.chmodSync(fake, 0o755);
  const out = await runClaudeCli('פגישה מחר', { ...cfg, claudePath: fake });
  const j = JSON.parse(out);
  assert.equal(j.reply, 'קיבלתי: פגישה מחר');
  assert.match(j.args, /-p --output-format json --model sonnet --tools Read/);
  assert.ok(fs.existsSync(paths.work));
});

test('resolveClaudePath falls back to this user\'s native install', () => {
  const { resolveClaudePath } = claudeMod;
  const home = 'D:\\Users\\Nurit';
  const local = 'D:\\Users\\Nurit\\.local\\bin\\claude.exe';
  const win = (files) => ({ home, platform: 'win32', exists: (p) => files.includes(p) });
  // config copied from another PC: that user's folder doesn't exist here
  assert.equal(resolveClaudePath('C:\\Users\\Yogi\\.local\\bin\\claude.exe', win([local])), local);
  // configured path that exists is kept
  assert.equal(resolveClaudePath('C:\\tools\\claude.exe', win(['C:\\tools\\claude.exe', local])), 'C:\\tools\\claude.exe');
  // default "claude": prefer the native install (often not on PATH), else leave it to PATH
  assert.equal(resolveClaudePath('claude', win([local])), local);
  assert.equal(resolveClaudePath('claude', win([])), 'claude');
  assert.equal(resolveClaudePath('', win([local])), local);
  // missing everywhere: keep the configured value so the error names it
  assert.equal(resolveClaudePath('C:\\Users\\Yogi\\.local\\bin\\claude.exe', win([])), 'C:\\Users\\Yogi\\.local\\bin\\claude.exe');
  // another bare command name is left alone
  assert.equal(resolveClaudePath('claude.cmd', win([local])), 'claude.cmd');
  assert.equal(resolveClaudePath('claude', { home: '/home/u', platform: 'linux', exists: (p) => p === '/home/u/.local/bin/claude' }), '/home/u/.local/bin/claude');
});

test('runClaudeCli uses the fallback when the configured claudePath is missing', async () => {
  const fake = path.join(tmp, 'fake-claude2.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({is_error:false,result:'ok'})));`);
  fs.chmodSync(fake, 0o755);
  const fakeHome = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(fakeHome, '.local', 'bin'), { recursive: true });
  fs.copyFileSync(fake, path.join(fakeHome, '.local', 'bin', 'claude'));
  fs.chmodSync(path.join(fakeHome, '.local', 'bin', 'claude'), 0o755);
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome; // os.homedir() reads HOME on Linux/macOS
  const warns = [];
  try {
    const out = await runClaudeCli('x', { ...cfg, claudePath: '/no/such/dir/claude' }, { log: { warn: (o) => warns.push(o) } });
    assert.equal(out, 'ok');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].using, path.join(fakeHome, '.local', 'bin', 'claude'));
  } finally {
    process.env.HOME = oldHome;
  }
});

test('prompt includes media instruction and send time', () => {
  const p = buildMessagePrompt(
    { cfg, now: new Date(), events: [{ id: 'x', summary: 'a', start: '2026-11-24T10:00', end: '2026-11-24T11:00' }], tasks: [], history: [] },
    [{ text: 'תראה', when: '2026-11-22 09:00', mediaFile: 'media/abc.jpg' }],
  );
  assert.match(p, /\[sent 2026-11-22 09:00\] תראה/);
  assert.match(p, /\.\/media\/abc\.jpg/);
  assert.match(p, /"id":"x"/);
});

// ---------------- watched chats / hourly scan ----------------
const { makeWatchMatcher, normName } = await import('../src/names.js');
const { Inbox } = await import('../src/inbox.js');
const { WhatsApp } = await import('../src/whatsapp.js');

test('normName / matcher tolerate spacing, Hebrew quotes, phone entries', () => {
  assert.equal(normName('משרד עו״ד  *חסיון עו״ד לקוח'), normName('משרד עו״ד *חסיון עו"ד לקוח'));
  const m = makeWatchMatcher(['נועם🐣', { name: 'אמא', phone: '+972-50-1234567' }]);
  assert.equal(m.match({ jids: ['x@lid'], name: 'נועם🐣' }), 'נועם🐣');
  assert.equal(m.match({ jids: ['972501234567@s.whatsapp.net'], name: '' }), 'אמא');
  assert.equal(m.match({ jids: ['y@lid'], name: 'מישהו' }), null);
});

function fakeWa(watchChats) {
  const inbox = new Inbox(path.join(tmp, `inbox-${Math.random()}.json`));
  const state = new State(path.join(tmp, `st-${Math.random()}.json`));
  const wa = new WhatsApp({ cfg: { ...cfg, watchChats }, state, log: { debug() {}, info() {}, warn() {}, error() {} }, inbox, onMessage() {} });
  wa.groupJid = 'self@g.us';
  return { wa, inbox };
}
const now = () => Math.floor(Date.now() / 1000);

test('handleWatched routes by address-book name, lid alt, group subject; ignores others', async () => {
  const { wa, inbox } = fakeWa(['דנה', 'המשפחה- קבוצה', 'אמא']);
  wa.contacts = { '972521111111@s.whatsapp.net': 'דנה', 'abc@lid': 'אמא' };
  wa.subjects = { 'fam@g.us': 'המשפחה- קבוצה', 'work@g.us': 'צוות' };
  await wa.handle({ key: { id: '1', remoteJid: 'zzz@lid', remoteJidAlt: '972521111111@s.whatsapp.net' }, messageTimestamp: now(), message: { conversation: 'מגיע לאסוף את נועם?' } });
  await wa.handle({ key: { id: '2', remoteJid: 'abc@lid', fromMe: true }, messageTimestamp: now(), message: { conversation: 'כן אמא' } });
  await wa.handle({ key: { id: '3', remoteJid: 'fam@g.us', participant: 'p@lid' }, pushName: 'נועם', messageTimestamp: now(), message: { imageMessage: { caption: 'תראו' } } });
  await wa.handle({ key: { id: '4', remoteJid: 'work@g.us', participant: 'p@lid' }, messageTimestamp: now(), message: { conversation: 'לא במעקב' } });
  const chats = inbox.data.chats;
  assert.deepEqual(Object.keys(chats).sort(), ['אמא', 'דנה', 'המשפחה- קבוצה'].sort());
  assert.equal(chats['דנה'].messages[0].sender, 'דנה');
  assert.equal(chats['אמא'].messages[0].sender, 'אני');
  assert.equal(chats['המשפחה- קבוצה'].messages[0].sender, 'נועם');
  assert.equal(chats['המשפחה- קבוצה'].messages[0].note, 'תמונה');
});

test('inbox: messages before first run are context only; markScanned advances', () => {
  const inbox = new Inbox(path.join(tmp, `inbox-${Math.random()}.json`));
  inbox.add('אמא', 'a@lid', { id: 'o', ts: inbox.data.initTs - 3600, fromMe: false, sender: 'אמא', text: 'ישן' });
  assert.equal(inbox.pending().length, 0);
  inbox.add('אמא', 'a@lid', { id: 'n', ts: inbox.data.initTs + 5, fromMe: false, sender: 'אמא', text: 'חדש' });
  inbox.add('אמא', 'a@lid', { id: 'n', ts: inbox.data.initTs + 5, fromMe: false, sender: 'אמא', text: 'חדש' }); // dup
  const p = inbox.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].fresh.length, 1);
  assert.equal(p[0].context[0].text, 'ישן');
  inbox.markScanned(p);
  assert.equal(inbox.pending().length, 0);
});

function makeScanProcessor(decisions, extraCfg = {}) {
  const r = makeProcessor(decisions);
  r.p.cfg = { ...cfg, scanQuietHours: [], ...extraCfg };
  r.p.inbox = new Inbox(path.join(tmp, `inbox-${Math.random()}.json`));
  return r;
}

test('scan: calendar changes are blocked, tasks added, report sent, inbox marked', async () => {
  const { p, sent, prompts, calendar, state } = makeScanProcessor([
    {
      calendar_actions: [{ op: 'create', summary: 'אסיפת הורים', start: '2026-11-25T18:00' }],
      task_actions: [{ op: 'add', text: 'לענות לדנה לגבי האיסוף' }],
      reply: '*דנה*: שואלת מי אוסף את נועם מחר → צריך לענות\n📅 להוסיף: אסיפת הורים – יום ד׳ 25.11 18:00?',
    },
  ]);
  p.inbox.add('דנה', 'r@lid', { id: 'a', ts: now() + 1, fromMe: false, sender: 'דנה', text: 'מי אוסף את נועם מחר? ויש אסיפת הורים ברביעי ב-6' });
  await p.scan();
  assert.equal(calendar.api.store.size, 0);
  assert.match(prompts[0], /HOURLY CHECK/);
  assert.match(prompts[0], /CHAT: "דנה"/);
  assert.match(prompts[0], /מי אוסף את נועם/);
  assert.match(sent[0], /^🔎 \*דנה\*/);
  assert.match(sent[0], /📝 משימה: לענות לדנה/);
  assert.equal(state.d.tasks.length, 1);
  assert.equal(p.inbox.pending().length, 0);
});

test('scan: nothing new -> no Claude call; nothing actionable -> silent; quiet hours skip', async () => {
  const { p, sent, prompts } = makeScanProcessor([{ reply: null }]);
  await p.scan();
  assert.equal(prompts.length, 0);
  p.inbox.add('אמא', 'a@lid', { id: 'x', ts: now() + 1, fromMe: false, sender: 'אמא', text: 'לילה טוב ❤️' });
  await p.scan();
  assert.equal(prompts.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(p.inbox.pending().length, 0);

  const q = makeScanProcessor([{ reply: 'x' }], { scanQuietHours: [0, 24] });
  q.p.inbox.add('אמא', 'a@lid', { id: 'y', ts: now() + 1, fromMe: false, sender: 'אמא', text: 'שאלה?' });
  await q.p.scan();
  assert.equal(q.prompts.length, 0);
  await q.p.scan(true); // manual /סרוק ignores quiet hours
  assert.equal(q.prompts.length, 1);
});

test('scan failure keeps messages for the next hour', async () => {
  const { p } = makeScanProcessor([new Error('boom')]);
  p.inbox.add('אמא', 'a@lid', { id: 'z', ts: now() + 1, fromMe: false, sender: 'אמא', text: 'שאלה?' });
  await p.scan();
  assert.equal(p.inbox.pending().length, 1);
});

test('quiet hours wrap past midnight', () => {
  const { p } = makeScanProcessor([], { scanQuietHours: [23, 7] });
  const at = (h) => new Date(`2026-11-22T${String(h).padStart(2, '0')}:30:00+02:00`);
  assert.equal(p.inQuietHours(at(23)), true);
  assert.equal(p.inQuietHours(at(3)), true);
  assert.equal(p.inQuietHours(at(7)), false);
  assert.equal(p.inQuietHours(at(14)), false);
});

test('watched chats: fresh images are downloaded and passed to Claude; old ones are not', async () => {
  const { wa, inbox } = fakeWa(['המשפחה- קבוצה']);
  wa.subjects = { 'fam@g.us': 'המשפחה- קבוצה' };
  const downloaded = [];
  wa.download = async (m) => (downloaded.push(m.key.id), { mediaFile: `media/${m.key.id}.jpg` });
  const img = (id, ts) => ({ key: { id, remoteJid: 'fam@g.us', participant: 'p@lid' }, pushName: 'דנה', messageTimestamp: ts, message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } });
  await wa.handle(img('old', inbox.data.initTs - 600));
  await wa.handle(img('new', inbox.data.initTs + 5));
  await wa.handle(img('new', inbox.data.initTs + 5)); // re-delivered duplicate: no second download
  assert.deepEqual(downloaded, ['new']);
  const pending = inbox.pending();
  const { buildScanPrompt } = await import('../src/prompts.js');
  const prompt = buildScanPrompt({ cfg, now: new Date(), events: [], tasks: [], history: [] }, pending, () => 't');
  assert.match(prompt, /attached: \.\/media\/new\.jpg/);
  assert.doesNotMatch(prompt, /old\.jpg/);
  assert.match(prompt, /open EVERY attached file/);
});

test('scan caps the number of attached files, newest first', async () => {
  const { p, prompts } = makeScanProcessor([{ reply: null }], { scanMaxFiles: 2 });
  for (let i = 1; i <= 4; i++) {
    p.inbox.add('המשפחה- קבוצה', 'fam@g.us', { id: `img${i}`, ts: now() + i, fromMe: false, sender: 'דנה', text: '', note: 'תמונה', mediaFile: `media/img${i}.jpg` });
  }
  await p.scan();
  assert.match(prompts[0], /media\/img4\.jpg/);
  assert.match(prompts[0], /media\/img3\.jpg/);
  assert.doesNotMatch(prompts[0], /media\/img1\.jpg/);
  assert.match(prompts[0], /לא נפתח – יותר מדי קבצים/);
});

const { normDateTime } = await import('../src/calendar.js');
test('normDateTime adds seconds and keeps offsets', () => {
  assert.equal(normDateTime('2026-11-23T10:00'), '2026-11-23T10:00:00');
  assert.equal(normDateTime('2026-11-23 9:05'), '2026-11-23T09:05:00');
  assert.equal(normDateTime('2026-11-23T10:00:30+02:00'), '2026-11-23T10:00:30+02:00');
  assert.throws(() => normDateTime('מחר'));
});
