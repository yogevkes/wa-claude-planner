// WA-Claude Planner settings UI (no framework, no build step).
// Everything coming from WhatsApp (group / contact names) is inserted with textContent only.

// ---------------- tiny helpers ----------------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // only for our own server-generated QR SVG
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);

// ---------------- inline icons (offline, no icon font) ----------------
const ICONS = {
  whatsapp: '<path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.5L3 20.5l1.4-4.7a8.5 8.5 0 1 1 16.1-4.2Z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3.5v3M16 3.5v3M3.5 9.5h17"/><path d="M8 13h2M14 13h2M8 16.5h2M14 16.5h2"/>',
  claude: '<path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5Z"/><path d="M18 16.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.8 20h18.4L12 4Z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
};
function icon(name, cls = '') {
  return h('span', {
    class: `ico ${cls}`.trim(),
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}
const AV_HUES = [162, 200, 222, 268, 318, 22, 38];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] || '';
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] || '' : '';
  return (first + last).toUpperCase();
}
function avatar(name, cls = '') {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + (ch.codePointAt(0) || 0)) % 997;
  return h('span', { class: `avatar ${cls}`.trim(), 'aria-hidden': 'true', style: `--av-h:${AV_HUES[hash % AV_HUES.length]}` }, initials(name));
}

async function call(method, path, body) {
  if (clickedBtn) {
    markBusy(clickedBtn);
    clickedBtn = null;
  }
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-wa-planner': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const api = { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };

function toast(text, bad = false) {
  const t = h(
    'div',
    { class: `toast ${bad ? 'toast-bad' : 'toast-ok'}`, role: bad ? 'alert' : 'status' },
    icon(bad ? 'alert' : 'check', 'toast-ico'),
    h('span', { class: 'toast-text' }, text),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'סגירה', onclick: () => t.remove() }, '✕'),
  );
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

// Spinners: a clicked action button shows a busy state until its request settles.
const busyBtns = new Set();
function clearBusy() {
  for (const el of busyBtns) {
    el.classList.remove('is-loading');
    el.removeAttribute('aria-busy');
    el.disabled = false;
  }
  busyBtns.clear();
}
function markBusy(el) {
  if (!el || !el.isConnected || el.disabled || busyBtns.has(el)) return;
  el.classList.add('is-loading');
  el.setAttribute('aria-busy', 'true');
  el.disabled = true;
  busyBtns.add(el);
}
// Remember which action button started a request; call() turns it busy for the duration.
let clickedBtn = null;
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('button.btn');
  clickedBtn = btn && (btn.closest('#app') || btn.id === 'pauseBtn') ? btn : null;
  if (clickedBtn) setTimeout(() => { if (clickedBtn === btn) clickedBtn = null; }, 0);
}, true);

async function act(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(okText);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    clearBusy();
  }
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// cron "30 7 * * *" <-> "07:30"
const cronToTime = (c) => {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(c || '').trim());
  return m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : null;
};
const timeToCron = (t) => {
  const [hh, mm] = t.split(':').map(Number);
  return `${mm} ${hh} * * *`;
};
const nameOf = (e) => (typeof e === 'string' ? e : e?.name || '');

// ---------------- app state ----------------
let S = null; // last /api/status
let offline = false;
const view = { mode: null, step: Number(store.get('wizardStep')) || 0 };
let stepSig = '';
let dashSig = '';
const dashSignature = () =>
  [S.whatsapp.status, S.whatsapp.me?.name, S.google.state, S.claude.state, S.claude.busy, S.paused, S.queued, S.setupComplete, S.group.jid].join('|');

const STATE_TEXT = {
  whatsapp: { open: 'מחובר', qr: 'ממתין לסריקה', connecting: 'מתחבר…', closed: 'מתחבר מחדש…', logged_out: 'נותק' },
  google: { ok: 'מחובר', not_authorized: 'לא מחובר', no_client: 'חסר חיבור', bad_client: 'חיבור לא תקין', error: 'שגיאה', unknown: 'בודק…' },
  claude: { ok: 'מוכן', not_installed: 'לא מותקן', not_logged_in: 'לא מחובר', error: 'שגיאה', unknown: 'בודק…' },
};
const tone = { open: 'ok', ok: 'ok', qr: 'warn', connecting: 'warn', closed: 'warn', unknown: 'warn', not_authorized: 'warn', not_logged_in: 'warn' };

function renderPills() {
  const pills = $('#pills');
  pills.replaceChildren();
  const chip = (ico, label, state, text) =>
    h(
      'span',
      { class: `pill ${tone[state] || 'bad'}`, title: `${label}: ${text}`, 'aria-label': `${label}: ${text}` },
      icon(ico, 'pill-ico'),
      h('span', { class: 'pill-label' }, label),
      h('span', { class: 'pill-state' }, text),
    );
  if (offline) {
    pills.append(chip('alert', 'השירות', 'bad', 'לא פעיל'));
    return;
  }
  if (!S) return;
  pills.append(
    chip('whatsapp', 'WhatsApp', S.whatsapp.status, STATE_TEXT.whatsapp[S.whatsapp.status] || S.whatsapp.status),
    chip('calendar', 'יומן', S.google.state, STATE_TEXT.google[S.google.state] || S.google.state),
    chip('claude', 'Claude', S.claude.busy ? 'unknown' : S.claude.state, S.claude.busy ? 'בודק…' : STATE_TEXT.claude[S.claude.state] || S.claude.state),
  );
  const pb = $('#pauseBtn');
  pb.hidden = !S.setupComplete;
  pb.replaceChildren(icon(S.paused ? 'play' : 'pause'), h('span', {}, S.paused ? 'המשך' : 'השהה'));
  pb.setAttribute('aria-pressed', String(S.paused));
  pb.title = S.paused ? 'הבוט מושהה. הודעות נשמרות ויטופלו כשתמשיך' : 'השהיית הבוט';
  pb.onclick = () => act(() => api.post('/api/pause', { paused: !S.paused }), S.paused ? 'הבוט ממשיך לעבוד' : 'הבוט מושהה');
}

// ---------------- chat picker ----------------
/**
 * Search box over WhatsApp groups / contacts.
 * @param {{type:'group'|'contact'|'all', placeholder:string, isPicked:(c)=>boolean, onPick:(c)=>void, keepOpen?:boolean}} o
 */
function chatPicker(o) {
  const input = h('input', { type: 'search', placeholder: o.placeholder, autocomplete: 'off', 'aria-label': o.placeholder });
  const results = h('div', { class: 'picker-results', role: 'listbox', hidden: true });
  const wrap = h('div', { class: 'picker' }, h('div', { class: 'search-field' }, icon('search', 'search-ico'), input), results);
  let items = [];
  let focus = -1;
  let timer;
  let refreshed = false;

  async function search() {
    const q = input.value.trim();
    const params = new URLSearchParams({ q, type: o.type });
    if (!refreshed) {
      params.set('refresh', '1');
      refreshed = true;
    }
    try {
      items = (await api.get(`/api/chats?${params}`)).chats;
    } catch (e) {
      items = [];
      toast(e.message, true);
    }
    focus = -1;
    draw();
  }
  function draw() {
    results.replaceChildren();
    results.hidden = false;
    if (!items.length) {
      const q = input.value.trim();
      results.append(
        h('div', { class: 'picker-empty' }, icon('search'),
          h('div', { class: 'picker-empty-title' }, q ? 'לא נמצאה התאמה' : 'אין עדיין שיחות להצגה'),
          h('div', { class: 'small muted' }, q ? 'נסה חלק מהשם. קבוצה חדשה? המתן רגע וחפש שוב.' : 'WhatsApp עוד מסנכרן, נסה שוב בעוד דקה.')),
      );
      return;
    }
    items.forEach((c, i) => {
      const picked = o.isPicked(c);
      const meta = c.phone ? `+${c.phone}` : c.type === 'group' ? 'קבוצה' : 'איש קשר';
      results.append(
        h(
          'button',
          {
            type: 'button',
            role: 'option',
            class: `picker-item${i === focus ? ' focus' : ''}${picked ? ' is-picked' : ''}`,
            'aria-selected': String(picked),
            onmousedown: (e) => e.preventDefault(),
            onclick: () => choose(c),
          },
          avatar(c.name),
          h('span', { class: 'picker-item-main' }, h('span', { class: 'picker-item-name' }, c.name), h('span', { class: `picker-item-meta${c.phone ? ' ltr' : ''}` }, meta)),
          picked ? icon('check', 'picker-item-check') : null,
        ),
      );
    });
  }
  function choose(c) {
    o.onPick(c);
    if (o.keepOpen) draw();
    else {
      results.hidden = true;
      input.value = '';
      input.blur();
    }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 180);
  });
  input.addEventListener('focus', search);
  input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focus = Math.max(0, Math.min(items.length - 1, focus + (e.key === 'ArrowDown' ? 1 : -1)));
      draw();
    } else if (e.key === 'Enter' && items[focus]) {
      e.preventDefault();
      choose(items[focus]);
    } else if (e.key === 'Escape') {
      results.hidden = true;
    }
  });
  return wrap;
}

function groupSection() {
  const box = h('div');
  const draw = () => {
    box.replaceChildren(
      chatPicker({
        type: 'group',
        placeholder: 'חיפוש קבוצה לפי שם…',
        isPicked: (c) => c.jid === S.group.jid,
        onPick: (c) => act(() => api.put('/api/config', { groupJid: c.jid, groupName: c.name }), `הבוט יאזין לקבוצה "${c.name}"`).then(draw),
      }),
      S.group.jid
        ? h(
            'div',
            { class: 'chosen' },
            avatar(S.group.name || S.group.jid),
            h('div', { class: 'chosen-main' },
              h('div', { class: 'chosen-kicker' }, icon('check'), 'הקבוצה שנבחרה'),
              h('div', { class: 'chosen-name' }, S.group.name || S.group.jid)),
            h('button', { class: 'btn secondary btn-sm', type: 'button', onclick: () => act(() => api.post('/api/test-message'), 'נשלחה הודעת בדיקה לקבוצה') }, icon('whatsapp'), 'שלח הודעת בדיקה'),
          )
        : h('p', { class: 'small muted chosen-hint' }, 'לא נבחרה קבוצה עדיין. חפש ובחר את הקבוצה שאיתה תכתוב לעוזר.'),
    );
  };
  draw();
  return box;
}

function watchSection() {
  const box = h('div');
  const chips = h('div', { class: 'chips' });
  const list = () => S.config.watchChats || [];
  const same = (e, c) => (typeof e === 'object' && e.jid && e.jid === c.jid) || nameOf(e) === c.name;
  const save = (next, msg) => act(() => api.put('/api/config', { watchChats: next }), msg).then(drawChips);
  function drawChips() {
    chips.replaceChildren(
      ...(list().length
        ? list().map((e) =>
            h('span', { class: 'chip' }, nameOf(e), h('button', { type: 'button', title: 'הסרה', 'aria-label': `הסרת ${nameOf(e)}`, onclick: () => save(list().filter((x) => x !== e), 'הוסר מהמעקב') }, '✕')),
          )
        : [h('span', { class: 'muted small' }, 'עוד לא נבחרו שיחות.')]),
    );
  }
  box.append(
    chatPicker({
      type: 'all',
      keepOpen: true,
      placeholder: 'חיפוש איש קשר או קבוצה…',
      isPicked: (c) => list().some((e) => same(e, c)),
      onPick: (c) => {
        const cur = list();
        const existing = cur.find((e) => same(e, c));
        if (existing) return save(cur.filter((e) => e !== existing), `"${c.name}" הוסר מהמעקב`);
        const entry = { name: c.name, jid: c.jid, ...(c.phone ? { phone: c.phone } : {}) };
        return save([...cur, entry], `"${c.name}" נוסף למעקב`);
      },
    }),
    chips,
  );
  drawChips();
  return box;
}

function prefsForm({ onSaved } = {}) {
  const c = S.config;
  const timeRow = (label, key, def) => {
    const cur = cronToTime(c[key]);
    const on = h('input', { type: 'checkbox', checked: Boolean(c[key]) });
    const time = h('input', { type: 'time', value: cur || def, disabled: !c[key] });
    let touched = false;
    on.addEventListener('change', () => (time.disabled = !on.checked));
    time.addEventListener('input', () => (touched = true));
    const custom = c[key] && !cur;
    return {
      el: h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'row' }, h('label', { class: 'inline-check' }, on, 'פעיל'), time, custom ? h('span', { class: 'hint' }, `(כרגע מוגדר לוח זמנים מותאם: ${c[key]})`) : null)),
      value: () => (on.checked ? (custom && !touched ? c[key] : timeToCron(time.value)) : ''),
    };
  };
  const morning = timeRow('סיכום בוקר', 'morningBrief', '07:30');
  const evening = timeRow('סיכום ערב ותכנון מחר', 'eveningBrief', '21:30');

  const SCANS = [['0 * * * *', 'כל שעה'], ['0 */2 * * *', 'כל שעתיים'], ['0 */3 * * *', 'כל 3 שעות'], ['', 'כבוי']];
  const scan = h('select', {}, ...SCANS.map(([v, t]) => h('option', { value: v, selected: v === (c.scanCron || '') }, t)));
  if (c.scanCron && !SCANS.some(([v]) => v === c.scanCron)) scan.prepend(h('option', { value: c.scanCron, selected: true }, `מותאם: ${c.scanCron}`));
  const hours = (sel) => h('select', {}, ...Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === sel }, `${String(i).padStart(2, '0')}:00`)));
  const [qFrom, qTo] = Array.isArray(c.scanQuietHours) && c.scanQuietHours.length === 2 ? c.scanQuietHours : [23, 7];
  const quietFrom = hours(qFrom);
  const quietTo = hours(qTo);

  const cal = h('select', { disabled: S.google.state !== 'ok' }, h('option', { value: c.calendarId || 'primary' }, c.calendarId && c.calendarId !== 'primary' ? c.calendarId : 'היומן הראשי'));
  if (S.google.state === 'ok') {
    api.get('/api/google/calendars').then(({ calendars }) => {
      if (!calendars.length) return;
      cal.replaceChildren(...calendars.map((x) => h('option', { value: x.primary ? 'primary' : x.id, selected: (c.calendarId || 'primary') === (x.primary ? 'primary' : x.id) }, x.primary ? `${x.summary} (ראשי)` : x.summary)));
    }).catch(() => {});
  }
  const ctx = h('textarea', { placeholder: 'למשל: עובד א׳-ה׳ 8:00-17:00 בחיפה, נסיעה של 40 דקות. אימון כושר בשני ורביעי בערב. חשוב לי שיזכיר לי ימי הולדת יום מראש.' });
  ctx.value = /^כתוב כאן/.test(c.userContext || '') ? '' : c.userContext || '';

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const patch = {
          morningBrief: morning.value(),
          eveningBrief: evening.value(),
          scanCron: scan.value,
          scanQuietHours: [Number(quietFrom.value), Number(quietTo.value)],
          calendarId: cal.value,
          userContext: ctx.value.trim(),
        };
        const r = await act(() => api.put('/api/config', patch), 'ההעדפות נשמרו');
        if (r) onSaved?.();
      },
    },
    h('div', { class: 'grid', style: 'gap:4px 22px' },
      h('div', {}, morning.el, evening.el),
      h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'בדיקת השיחות במעקב'), scan),
        h('div', { class: 'field' }, h('label', {}, 'שעות שקט (בלי בדיקות והתראות)'), h('div', { class: 'row' }, 'מ-', quietFrom, 'עד', quietTo)),
        h('div', { class: 'field' }, h('label', {}, 'יומן'), cal),
      ),
    ),
    h('div', { class: 'field' }, h('label', {}, 'קצת עליך'), h('div', { class: 'hint' }, 'עוזר ל-Claude לתכנן טוב יותר: שעות עבודה, נסיעות קבועות, הרגלים, מה חשוב לך שיזכיר.'), ctx),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'שמירה')),
  );
  return form;
}

function statusBox(kind, icon, title, ...body) {
  return h('div', { class: `status-box ${kind}` }, h('div', { class: 'big', 'aria-hidden': 'true' }, icon), h('div', {}, h('div', { class: 'title' }, title), ...body));
}

// ---------------- wizard ----------------
const STEPS = [
  {
    id: 'welcome',
    label: 'ברוכים הבאים',
    done: () => store.get('welcomeSeen') === '1',
    sig: () => '',
    render: () => {
      store.set('welcomeSeen', '1');
      const pathInput = h('input', { type: 'text', dir: 'ltr', placeholder: 'D:\\claude\\wa-claude' });
      return h('div', {},
        h('h1', {}, 'בוא נגדיר את העוזר שלך'),
        h('p', { class: 'lead' }, 'כל מה שתכתוב לעצמך בקבוצת WhatsApp אישית יעבור ל-Claude, שיעדכן את Google Calendar ויענה לך באותה קבוצה.'),
        h('ul', { class: 'feature-list' },
          ...[
            ['📅', 'פגישות, תזכורות ושינויים ביומן מתוך הודעה רגילה, כולל צילומי הזמנות ומסמכים'],
            ['☀️', 'סיכום בוקר וסיכום ערב עם תכנון למחר'],
            ['🔔', 'מעקב אחרי שיחות שתבחר, והתראה כשמשהו דורש ממך פעולה'],
            ['🔒', 'הכל רץ על המחשב הזה. ההודעות נשלחות רק ל-Claude, עם המנוי שלך'],
          ].map(([i, t]) => h('li', {}, h('span', { class: 'ico' }, i), h('span', {}, t))),
        ),
        h('p', { class: 'muted' }, 'מה צריך: מנוי Claude (Pro או Max), חשבון Google, והטלפון עם WhatsApp לסריקת קוד. זה לוקח כ-5 דקות.'),
        h('details', {},
          h('summary', {}, 'יש לי כבר התקנה קודמת (תיקיית wa-claude)'),
          h('p', { class: 'small muted' }, 'אפשר להעביר ממנה את חיבור ה-WhatsApp, היומן, המשימות וההגדרות, בלי לסרוק שוב. קודם עוצרים את הבוט הישן (במחשב הישן: windows\\uninstall-autostart.ps1).'),
          h('div', { class: 'row' }, pathInput,
            h('button', { class: 'btn', type: 'button', onclick: () => importFrom(pathInput.value) }, 'ייבוא')),
        ),
      );
    },
  },
  {
    id: 'claude',
    label: 'Claude',
    done: () => S.claude.state === 'ok',
    sig: () => `${S.claude.state}|${S.claude.busy}|${S.claude.installing}|${(S.claude.installLog || '').length}`,
    render: () => {
      const c = S.claude;
      const recheck = h('button', { class: 'btn', type: 'button', disabled: c.busy, onclick: () => act(() => api.post('/api/claude/check')) }, c.busy ? 'בודק…' : 'בדוק שוב');
      let box;
      if (c.installing) box = statusBox('warn', '⏳', 'מתקין את Claude Code…', h('p', { class: 'small' }, 'זה לוקח דקה או שתיים.'), h('pre', { class: 'log' }, c.installLog || ''));
      else if (c.busy || c.state === 'unknown') box = statusBox('', '⏳', 'בודק את Claude Code…');
      else if (c.state === 'ok') box = statusBox('ok', '✅', 'Claude Code מותקן ומחובר', h('p', { class: 'small' }, 'הבוט ישתמש במנוי שלך. אין צורך במפתח API.'));
      else if (c.state === 'not_installed')
        box = statusBox('warn', '📦', 'Claude Code לא מותקן במחשב הזה',
          h('p', { class: 'small' }, 'זה הכלי הרשמי של Anthropic שדרכו הבוט מדבר עם Claude. ההתקנה למשתמש הנוכחי, בלי הרשאות מנהל.'),
          S.platform === 'win32' ? h('button', { class: 'btn primary', type: 'button', onclick: () => act(() => api.post('/api/claude/install'), 'ההתקנה התחילה') }, 'התקן את Claude Code') : h('p', { class: 'small' }, 'התקנה: https://claude.com/claude-code'));
      else if (c.state === 'not_logged_in')
        box = statusBox('warn', '🔑', 'צריך להתחבר ל-Claude פעם אחת',
          h('ol', { class: 'howto small' },
            h('li', {}, 'לוחצים על הכפתור, ונפתח חלון שחור של Claude Code.'),
            h('li', {}, 'בוחרים התחברות עם חשבון Claude (המנוי), ומאשרים בדפדפן.'),
            h('li', {}, 'כשמופיעה שורת הכתיבה של Claude, כותבים /exit וסוגרים את החלון.'),
          ),
          S.platform === 'win32' ? h('button', { class: 'btn primary', type: 'button', onclick: () => act(() => api.post('/api/claude/login'), 'נפתח חלון התחברות') }, 'פתח חלון התחברות') : null);
      else box = statusBox('bad', '⚠️', 'Claude Code לא עונה', h('pre', { class: 'log' }, c.error || ''));
      return h('div', {}, h('h1', {}, 'חיבור ל-Claude'), h('p', { class: 'lead' }, 'Claude הוא המוח של העוזר: הוא קורא את ההודעות שלך ומחליט מה לעשות ביומן.'), box, h('div', { class: 'row' }, recheck));
    },
  },
  {
    id: 'google',
    label: 'Google Calendar',
    done: () => S.google.state === 'ok',
    sig: () => `${S.google.state}|${S.google.hasClient}|${S.google.error}`,
    render: () => {
      const g = S.google;
      let box;
      if (g.state === 'ok') box = statusBox('ok', '✅', 'Google Calendar מחובר');
      else if (!g.hasClient) {
        const file = h('input', { type: 'file', accept: '.json,application/json' });
        file.addEventListener('change', async () => {
          const f = file.files[0];
          if (!f) return;
          const text = await f.text();
          act(() => api.post('/api/google/client', { client: text }), 'פרטי החיבור נשמרו. עכשיו אפשר לחבר את היומן');
        });
        box = statusBox('warn', '🧩', 'בהתקנה הזו אין חיבור מוכן ל-Google',
          h('p', { class: 'small' }, 'צריך קובץ OAuth client מסוג Desktop app מ-Google Cloud Console (ההוראות ב-README, בסעיף "חיבור Google Calendar"). מעלים אותו כאן:'),
          file);
      } else {
        box = h('div', {},
          g.state === 'error' && g.error ? statusBox('bad', '⚠️', 'החיבור נכשל', h('p', { class: 'small', dir: 'ltr' }, g.error)) : null,
          h('ol', { class: 'howto' },
            h('li', {}, 'לוחצים על הכפתור. ייפתח דף של Google בלשונית חדשה.'),
            h('li', {}, 'בוחרים את חשבון ה-Google שלך ומאשרים גישה ליומן.'),
            h('li', {}, 'אם מופיע "Google hasn’t verified this app": לוחצים Advanced ואז Go to…'),
          ),
          h('button', {
            class: 'btn primary', type: 'button',
            onclick: async () => {
              const w = window.open('about:blank', '_blank');
              const r = await act(() => api.post('/api/google/auth'));
              if (r?.url) {
                if (w) w.location = r.url;
                else window.location.href = r.url;
                toast('ממתין לאישור בלשונית של Google…');
              } else w?.close();
            },
          }, 'חבר את Google Calendar'),
          h('p', { class: 'small muted', style: 'margin-top:12px' }, 'האזהרה של Google צפויה: זו אפליקציה פרטית למשפחה וחברים שלא עברה בדיקה של Google. הגישה היא רק ליומן שלך, והמידע נשאר במחשב הזה.'),
        );
      }
      return h('div', {}, h('h1', {}, 'חיבור ליומן'), h('p', { class: 'lead' }, 'Claude יוסיף, יזיז ויעדכן אירועים ביומן שלך, ויקרא אותו כדי לתכנן.'), box);
    },
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    done: () => S.whatsapp.status === 'open',
    sig: () => S.whatsapp.status,
    render: () => {
      const w = S.whatsapp;
      if (w.status === 'open') {
        return h('div', {}, h('h1', {}, 'חיבור ל-WhatsApp'),
          statusBox('ok', '✅', `WhatsApp מחובר${w.me?.name ? ` (${w.me.name})` : ''}`, h('p', { class: 'small' }, 'המחשב מופיע בטלפון ברשימת "מכשירים מקושרים".')),
          h('button', { class: 'btn ghost danger', type: 'button', onclick: () => confirm('לנתק את החיבור הנוכחי ולסרוק קוד חדש?') && act(() => api.post('/api/whatsapp/relink'), 'מכין קוד חדש…') }, 'קישור מחשבון אחר'));
      }
      const qr = h('div', { class: 'qr', id: 'qr' }, w.status === 'qr' ? 'טוען קוד…' : 'מתחבר ל-WhatsApp…');
      if (w.status === 'qr') loadQr(qr);
      const phone = h('input', { type: 'tel', dir: 'ltr', placeholder: '972501234567' });
      const codeOut = h('div');
      return h('div', {},
        h('h1', {}, 'חיבור ל-WhatsApp'),
        h('p', { class: 'lead' }, 'המחשב יתחבר כמו WhatsApp Web, כ"מכשיר מקושר" של הטלפון שלך.'),
        h('div', { class: 'qr-wrap' }, qr,
          h('div', {},
            h('ol', { class: 'howto' },
              h('li', {}, 'פותחים את WhatsApp בטלפון'),
              h('li', {}, 'הגדרות ← מכשירים מקושרים ← קישור מכשיר'),
              h('li', {}, 'מכוונים את המצלמה לקוד'),
            ),
            h('details', {},
              h('summary', {}, 'אין מצלמה? קישור עם מספר טלפון'),
              h('div', { class: 'row' }, phone,
                h('button', { class: 'btn', type: 'button', onclick: async () => {
                  const r = await act(() => api.post('/api/whatsapp/pair', { phone: phone.value }));
                  if (r?.code) codeOut.replaceChildren(h('p', { class: 'small' }, 'בטלפון: מכשירים מקושרים ← קישור מכשיר ← קישור עם מספר טלפון, והקלד:'), h('div', { class: 'pair-code' }, r.code));
                } }, 'קבל קוד')),
              codeOut,
            ),
            h('p', { class: 'small muted' }, 'זה חיבור לא רשמי (כמו WhatsApp Web). שימוש אישי ומתון כמו כאן נחשב בטוח בדרך כלל, אבל אין לזה אישור של WhatsApp.'),
          ),
        ),
      );
    },
  },
  {
    id: 'group',
    label: 'הקבוצה שלך',
    done: () => Boolean(S.group.jid),
    sig: () => `${S.whatsapp.status === 'open'}|${S.group.jid}`,
    render: () =>
      h('div', {},
        h('h1', {}, 'הקבוצה שלך עם עצמך'),
        h('p', { class: 'lead' }, 'הבוט מקשיב לקבוצת WhatsApp אחת שבה רק אתה חבר. שם כותבים לו, ושם הוא עונה.'),
        S.whatsapp.status !== 'open'
          ? statusBox('warn', '📱', 'קודם צריך לחבר את WhatsApp')
          : h('div', {},
              h('details', {}, h('summary', {}, 'אין לך קבוצה כזו? כך יוצרים'),
                h('ol', { class: 'howto small' },
                  h('li', {}, 'ב-WhatsApp: קבוצה חדשה, מוסיפים איש קשר כלשהו, נותנים שם (למשל "קבוצה שלי עם עצמי") ויוצרים.'),
                  h('li', {}, 'בפרטי הקבוצה מסירים את איש הקשר. נשארת קבוצה רק איתך.'),
                  h('li', {}, 'חוזרים לכאן ומחפשים אותה. אם היא לא מופיעה, מחכים כמה שניות ומחפשים שוב.'),
                )),
              groupSection(),
            ),
      ),
  },
  {
    id: 'chats',
    label: 'שיחות במעקב',
    optional: true,
    done: () => store.get('chatsSeen') === '1' || (S.config.watchChats || []).length > 0,
    sig: () => `${S.whatsapp.status === 'open'}`,
    render: () => {
      store.set('chatsSeen', '1');
      return h('div', {},
        h('h1', {}, 'שיחות במעקב (לא חובה)'),
        h('p', { class: 'lead' }, 'פעם בשעה הבוט יעבור על השיחות שתבחר, ויכתוב לך בקבוצה אם משהו דורש פעולה או תיאום. אירועים שהוא מוצא שם מוצעים לך לאישור, ולא נכנסים ליומן לבד.'),
        S.whatsapp.status !== 'open' ? statusBox('warn', '📱', 'קודם צריך לחבר את WhatsApp') : watchSection(),
        h('p', { class: 'small muted', style: 'margin-top:16px' }, 'ההודעות מהשיחות האלו נשמרות רק על המחשב הזה, ונשלחות ל-Claude לניתוח בזמן הבדיקה.'),
      );
    },
  },
  {
    id: 'prefs',
    label: 'העדפות',
    optional: true,
    done: () => store.get('prefsSeen') === '1',
    sig: () => S.google.state,
    render: () => {
      store.set('prefsSeen', '1');
      return h('div', {}, h('h1', {}, 'העדפות'), h('p', { class: 'lead' }, 'אפשר לשנות את כל זה גם אחר כך.'), prefsForm({ onSaved: () => go(view.step + 1) }));
    },
  },
  {
    id: 'finish',
    label: 'סיום',
    done: () => S.setupComplete,
    sig: () => `${S.setupComplete}|${S.claude.state}|${S.google.state}|${S.whatsapp.status}|${S.group.jid}`,
    render: () => {
      if (!S.setupComplete) {
        const missing = STEPS.filter((s) => !s.optional && s.id !== 'finish' && s.id !== 'welcome' && !s.done());
        return h('div', {}, h('h1', {}, 'כמעט שם'), h('p', { class: 'lead' }, 'נשאר להשלים:'),
          h('ul', { class: 'feature-list' }, ...missing.map((s) => h('li', {}, h('span', { class: 'ico' }, '•'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); go(STEPS.indexOf(s)); } }, s.label)))));
      }
      return h('div', {},
        h('h1', {}, '🎉 הכל מוכן'),
        h('p', { class: 'lead' }, `העוזר מאזין לקבוצה "${S.group.name}". נסה לכתוב שם:`),
        h('ul', { class: 'feature-list' },
          ...['פגישה עם רוני מחר ב-10 בקפה', 'תזכיר לי לקנות מתנה לאמא ביום חמישי', 'מה יש לי השבוע?', '/עזרה'].map((t) => h('li', {}, h('span', { class: 'ico' }, '💬'), h('span', {}, t)))),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => act(() => api.post('/api/test-message'), 'נשלחה הודעת בדיקה') }, 'שלח הודעת בדיקה'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => { store.set('wizardDone', '1'); view.mode = 'dashboard'; render(); } }, 'ללוח הבקרה')),
        h('p', { class: 'small muted', style: 'margin-top:18px' }, 'העוזר עולה אוטומטית עם Windows. אפשר לפתוח את המסך הזה מסמל המגש ליד השעון.'),
      );
    },
  },
];

function go(i) {
  view.step = Math.max(0, Math.min(STEPS.length - 1, i));
  store.set('wizardStep', String(view.step));
  render();
}

function renderWizard() {
  const step = STEPS[view.step];
  stepSig = step.sig();
  const nav = h('div', { class: 'step-nav' },
    view.step > 0 ? h('button', { class: 'btn ghost', type: 'button', onclick: () => go(view.step - 1) }, '→ הקודם') : h('span'),
    step.id === 'finish' ? h('span') : h('button', { class: 'btn', type: 'button', id: 'nextBtn', onclick: () => go(view.step + 1) }),
  );
  setTimeout(updateNav);
  return h('div', { class: 'wizard' },
    h('ol', { class: 'steps card' },
      ...STEPS.map((s, i) => h('li', {
        class: `${i === view.step ? 'active' : ''} ${s.done() ? 'done' : ''}`,
        role: 'button',
        tabindex: 0,
        'aria-current': i === view.step ? 'step' : null,
        onclick: () => go(i),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(i); } },
      },
        h('span', { class: 'num' }, s.done() && i !== view.step ? '✓' : String(i + 1)), h('span', { class: 'label' }, s.label)))),
    h('section', { class: 'card step-body' }, h('div', { class: 'content', id: 'stepContent' }, step.render()), nav),
  );
}

function updateNav() {
  const step = STEPS[view.step];
  const btn = $('#nextBtn');
  if (btn) {
    const canNext = step.done() || step.optional || step.id === 'welcome';
    btn.disabled = !canNext;
    btn.classList.toggle('primary', canNext);
    btn.textContent = step.optional && !step.done() ? 'דלג ←' : 'המשך ←';
  }
  const lis = document.querySelectorAll('.steps li');
  STEPS.forEach((s, i) => {
    lis[i]?.classList.toggle('done', s.done());
    const num = lis[i]?.querySelector('.num');
    if (num) num.textContent = s.done() && i !== view.step ? '✓' : String(i + 1);
  });
}

let qrTimer;
async function loadQr(el = $('#qr')) {
  clearTimeout(qrTimer);
  if (!el) return;
  try {
    const r = await api.get('/api/whatsapp/qr');
    if (r.svg && el) el.innerHTML = r.svg; // SVG generated by our own server
  } catch { /* next poll */ }
  if (S?.whatsapp.status === 'qr' && view.mode === 'wizard' && STEPS[view.step].id === 'whatsapp') qrTimer = setTimeout(() => loadQr(), 4000);
}

// ---------------- dashboard ----------------
function renderDashboard() {
  dashSig = dashSignature();
  const g = S.google;
  const c = S.claude;
  const w = S.whatsapp;
  const badgeIcon = (state) => (state === 'unknown' ? 'refresh' : tone[state] === 'ok' ? 'check' : 'alert');
  const statusRow = (ico, label, state, text, detail, ...actions) =>
    h('div', { class: 'status-row' },
      icon(ico, `status-ico ${tone[state] || 'bad'}`),
      h('div', { class: 'status-main' },
        h('div', { class: 'status-title' },
          h('span', { class: 'status-label' }, label),
          h('span', { class: `state-badge ${tone[state] || 'bad'}` }, icon(badgeIcon(state)), text)),
        detail ? h('div', { class: 'status-detail' }, detail) : null),
      h('div', { class: 'status-action' }, ...actions));
  const logList = h('ul', { class: 'log-list' }, h('li', { class: 'muted' }, 'טוען…'));
  loadLogs(logList);

  return h('div', {},
    !S.setupComplete
      ? h('div', { class: 'banner' }, icon('alert', 'banner-ico'),
          h('div', { class: 'banner-text' }, h('strong', {}, 'ההגדרה לא הושלמה. '), 'משהו בהגדרות דורש תשומת לב, והבוט לא יכול לעבוד עד שזה יסודר.'),
          h('button', { class: 'btn secondary btn-sm', type: 'button', onclick: () => { view.mode = 'wizard'; go(STEPS.findIndex((s) => !s.optional && s.id !== 'welcome' && !s.done())); } }, 'לסדר עכשיו'))
      : null,
    S.paused
      ? h('div', { class: 'banner' }, icon('pause', 'banner-ico'),
          h('div', { class: 'banner-text' }, `הבוט מושהה.${S.queued ? ` ${S.queued} הודעות ממתינות ויטופלו כשתמשיך.` : ''}`))
      : null,
    h('div', { class: 'grid dash' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'מצב המערכת')),
        h('div', { class: 'status-list' },
          statusRow('whatsapp', 'WhatsApp', w.status, STATE_TEXT.whatsapp[w.status] || w.status, w.me?.name ? `חשבון: ${w.me.name}` : '',
            w.status !== 'open' ? h('button', { class: 'btn secondary btn-sm', type: 'button', onclick: () => { view.mode = 'wizard'; go(STEPS.findIndex((s) => s.id === 'whatsapp')); } }, 'קישור') : null),
          statusRow('calendar', 'יומן', g.state, STATE_TEXT.google[g.state] || g.state, g.state === 'ok' ? 'הרשאה פעילה ליומן' : g.state === 'unknown' ? 'בודק את החיבור…' : g.hasClient ? 'נדרשת התחברות' : 'חסר קובץ חיבור',
            h('button', { class: 'btn secondary btn-sm', type: 'button', onclick: () => { view.mode = 'wizard'; go(STEPS.findIndex((s) => s.id === 'google')); } }, g.state === 'ok' ? 'חיבור מחדש' : 'חיבור')),
          statusRow('claude', 'Claude', c.busy ? 'unknown' : c.state, c.busy ? 'בודק…' : STATE_TEXT.claude[c.state] || c.state, c.busy ? 'בודק התקנה והתחברות' : c.state === 'ok' ? 'מנוי Claude Code' : 'נדרשת התקנה או התחברות',
            h('button', { class: 'btn secondary btn-sm', type: 'button', disabled: c.busy, onclick: () => act(() => api.post('/api/claude/check'), 'נבדק') }, 'בדיקה'),
            c.state === 'not_logged_in' || c.state === 'not_installed' ? h('button', { class: 'btn secondary btn-sm', type: 'button', onclick: () => { view.mode = 'wizard'; go(STEPS.findIndex((s) => s.id === 'claude')); } }, 'לסדר') : null),
        ),
      ),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'הקבוצה שלי')), S.whatsapp.status === 'open' ? groupSection() : h('p', { class: 'muted' }, `${S.group.name || 'לא נבחרה'} · אפשר לשנות כש-WhatsApp מחובר`)),
      h('section', { class: 'card span-2' }, h('div', { class: 'card-head' }, h('h2', {}, 'שיחות במעקב')), h('p', { class: 'muted small' }, 'הבוט בודק אותן לפי לוח הזמנים בהעדפות ומתריע כשמשהו דורש פעולה.'), watchSection()),
      h('section', { class: 'card span-2' }, h('div', { class: 'card-head' }, h('h2', {}, 'העדפות')), prefsForm()),
      h('section', { class: 'card span-2' },
        h('div', { class: 'card-head' }, h('h2', {}, 'פעילות אחרונה'), h('button', { class: 'btn ghost btn-sm', type: 'button', onclick: () => loadLogs(logList) }, icon('refresh'), 'רענון')),
        logList),
      h('section', { class: 'card span-2' },
        h('div', { class: 'card-head' }, h('h2', {}, 'מתקדם')),
        h('div', { class: 'info-list' },
          h('div', { class: 'info-row' }, h('span', { class: 'info-k' }, 'גרסה'), h('span', { class: 'info-v' }, S.version)),
          h('div', { class: 'info-row' }, h('span', { class: 'info-k' }, 'תיקיית נתונים'), h('span', { class: 'info-v ltr' }, S.dataDir)),
        ),
        S.platform === 'win32'
          ? h('div', { class: 'advanced-extra' },
              h('p', { class: 'small muted' }, 'מחשב שאמור לעבוד תמיד? אפשר להפעיל את הבוט כבר בעליית Windows, גם בלי שמישהו נכנס למשתמש (למשל אחרי עדכון Windows). נדרש אישור מנהל.'),
              h('button', { class: 'btn secondary', type: 'button', onclick: () => act(() => api.post('/api/autostart/boot'), 'אשר את חלון ההרשאות של Windows') }, 'הפעלה גם בלי כניסה ל-Windows'))
          : null,
        h('div', { class: 'row advanced-extra' },
          h('button', { class: 'btn secondary btn-sm', type: 'button', onclick: () => { view.mode = 'wizard'; go(0); } }, 'אשף ההגדרה'),
          h('button', { class: 'btn secondary btn-sm', type: 'button', onclick: () => confirm('להפעיל מחדש את הבוט?') && restart('/api/restart') }, 'הפעלה מחדש'),
        ),
      ),
    ),
  );
}

async function loadLogs(ul) {
  try {
    const { lines } = await api.get('/api/logs?lines=120');
    ul.replaceChildren(...lines.reverse().map((l) => h('li', { class: `lv-${l.level}` },
      h('time', {}, l.time ? new Date(l.time).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''),
      h('span', { dir: 'auto' }, l.msg + (l.err ? ` · ${l.err}` : '')))));
    if (!lines.length) ul.replaceChildren(h('li', { class: 'muted' }, 'אין עדיין פעילות.'));
  } catch (e) {
    ul.replaceChildren(h('li', { class: 'muted' }, e.message));
  } finally {
    clearBusy();
  }
}

async function restart(path, body) {
  try {
    await api.post(path, body);
    toast('מפעיל מחדש…');
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 2500));
    while (Date.now() - t0 < 90000) {
      try {
        await api.get('/api/status');
        location.reload();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    toast('השירות לא חזר. אם אין סמל במגש, הפעל את WA-Claude Planner מתפריט התחל.', true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    clearBusy();
  }
}

function importFrom(p) {
  if (!p.trim()) return toast('הדבק את הנתיב לתיקייה של ההתקנה הקודמת', true);
  if (!confirm('לייבא את החיבורים וההגדרות מההתקנה הקודמת? מה שהוגדר כאן עד עכשיו יוחלף.')) return;
  restart('/api/import', { path: p });
}

// ---------------- render loop ----------------
function render() {
  renderPills();
  const app = $('#app');
  if (!S) return;
  if (!view.mode) view.mode = S.setupComplete ? 'dashboard' : 'wizard';
  app.replaceChildren(view.mode === 'wizard' ? renderWizard() : renderDashboard());
}

async function refresh() {
  try {
    S = await api.get('/api/status');
    offline = false;
  } catch {
    offline = true;
    renderPills();
    return;
  }
  if (!$('#app .wizard') && !$('#app .grid')) return render();
  renderPills();
  const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (view.mode === 'dashboard') {
    if (dashSignature() !== dashSig && !typing) render();
  } else {
    const step = STEPS[view.step];
    if (step.sig() !== stepSig && !typing) render();
    else updateNav(); // keep the step list + next button current without touching the content
  }
}

refresh();
setInterval(refresh, 2500);
