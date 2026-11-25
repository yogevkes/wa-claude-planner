import fs from 'node:fs';
import { google } from 'googleapis';
import { paths } from './config.js';

export const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const BOT_TAG = 'waClaude';

/** Thrown with a .code so the app can tell the user what to do */
export class GoogleSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'no_client' | 'bad_client' | 'not_authorized'
  }
}

/** The user's own OAuth client (data\google-credentials.json) wins over the one shipped with the app */
export function googleClientFile() {
  if (fs.existsSync(paths.googleCreds)) return paths.googleCreds;
  if (fs.existsSync(paths.bundledGoogleClient)) return paths.bundledGoogleClient;
  return null;
}

/** Validate an OAuth client JSON (as downloaded from Google Cloud) and return {client_id, client_secret} */
export function parseOAuthClient(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const c = obj?.installed || obj?.web;
  if (!c?.client_id || !c?.client_secret) throw new GoogleSetupError('bad_client', 'OAuth client JSON must be of type "Desktop app" (has "installed.client_id").');
  return c;
}

export function loadOAuthClient() {
  const file = googleClientFile();
  if (!file) {
    throw new GoogleSetupError(
      'no_client',
      `Missing ${paths.googleCreds}. Download the OAuth "Desktop app" client JSON from Google Cloud Console and save it there (see README).`,
    );
  }
  const c = parseOAuthClient(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return new google.auth.OAuth2(c.client_id, c.client_secret);
}

export function getAuthorizedClient() {
  const client = loadOAuthClient();
  if (!fs.existsSync(paths.googleToken)) {
    throw new GoogleSetupError('not_authorized', 'Google is not authorized yet. Run: npm run google-auth');
  }
  const token = JSON.parse(fs.readFileSync(paths.googleToken, 'utf8'));
  client.setCredentials(token);
  // Persist refreshed tokens (keep the refresh_token if Google omits it)
  client.on('tokens', (t) => {
    const merged = { ...token, ...t };
    if (!t.refresh_token) merged.refresh_token = token.refresh_token;
    fs.writeFileSync(paths.googleToken, JSON.stringify(merged, null, 2));
  });
  return client;
}

// ---------- date helpers (naive local "YYYY-MM-DDTHH:mm[:ss]" arithmetic) ----------
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMinutes(dt, n) {
  const hasOffset = /([+-]\d\d:\d\d|Z)$/.test(dt);
  if (hasOffset) return new Date(new Date(dt).getTime() + n * 60000).toISOString();
  const base = dt.length === 16 ? `${dt}:00` : dt.slice(0, 19);
  const d = new Date(`${base}Z`);
  return new Date(d.getTime() + n * 60000).toISOString().slice(0, 19);
}

const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/** Google needs full RFC3339 date-times: "2026-11-23T10:00" -> "2026-11-23T10:00:00" (offset kept if present) */
export function normDateTime(dt) {
  const m = String(dt).trim().replace(' ', 'T').match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) throw new Error(`bad date-time: ${dt}`);
  const [, d, h, mi, sec = '00', off = ''] = m;
  return `${d}T${h.padStart(2, '0')}:${mi}:${sec}${off}`;
}

/** Convert a Claude action (create / merged update) into Google start/end/reminders fields */
export function buildTimeFields(a, tz, defaultReminder) {
  const out = {};
  const allDay = a.all_day === true || (isDateOnly(a.start) && a.all_day !== false);
  if (allDay) {
    const start = a.start.slice(0, 10);
    let end = a.end ? a.end.slice(0, 10) : start; // Claude gives inclusive last day
    if (end < start) end = start;
    out.start = { date: start };
    out.end = { date: addDays(end, 1) }; // Google's end date is exclusive
  } else {
    if (!a.start || isDateOnly(a.start)) throw new Error(`timed event needs start date+time: ${a.start}`);
    const start = normDateTime(a.start);
    const end = a.end && !isDateOnly(a.end) ? normDateTime(a.end) : addMinutes(start, 60);
    out.start = { dateTime: start, timeZone: tz };
    out.end = { dateTime: end, timeZone: tz };
  }
  if (Array.isArray(a.reminders_minutes)) {
    out.reminders = a.reminders_minutes.length
      ? { useDefault: false, overrides: a.reminders_minutes.slice(0, 5).map((m) => ({ method: 'popup', minutes: Number(m) })) }
      : { useDefault: true };
  } else if (defaultReminder != null && !allDay) {
    out.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: defaultReminder }] };
  }
  return out;
}

const SNAPSHOT_FIELDS = ['summary', 'description', 'location', 'start', 'end', 'reminders', 'extendedProperties', 'colorId'];
const snapshot = (ev) => Object.fromEntries(SNAPSHOT_FIELDS.filter((k) => ev[k] !== undefined).map((k) => [k, ev[k]]));

/** Event -> compact representation for the prompt */
function compact(ev) {
  const s = ev.start?.dateTime ? ev.start.dateTime.slice(0, 16) : ev.start?.date;
  let e = ev.end?.dateTime ? ev.end.dateTime.slice(0, 16) : ev.end?.date;
  const allDay = !ev.start?.dateTime;
  if (allDay && e) e = addDays(e, -1); // show inclusive last day
  const out = { id: ev.id, summary: ev.summary || '(ללא כותרת)', start: s, end: e };
  if (allDay) out.all_day = true;
  if (ev.location) out.location = ev.location;
  if (ev.description) out.description = ev.description.slice(0, 200);
  if (ev.recurringEventId) out.recurring = true;
  if (ev.extendedProperties?.private?.[BOT_TAG]) out.created_by_bot = true;
  return out;
}

export class Calendar {
  constructor(auth, cfg) {
    this.api = google.calendar({ version: 'v3', auth });
    this.cfg = cfg;
    this.id = cfg.calendarId || 'primary';
    this.tz = cfg.timezone;
  }

  async listWindow(fromDays = -this.cfg.calendarLookbackDays, toDays = this.cfg.calendarLookaheadDays) {
    const now = Date.now();
    const res = await this.api.events.list({
      calendarId: this.id,
      timeMin: new Date(now + fromDays * 86400000).toISOString(),
      timeMax: new Date(now + toDays * 86400000).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      timeZone: this.tz,
    });
    return (res.data.items || []).filter((e) => e.status !== 'cancelled').map(compact);
  }

  async get(id) {
    return (await this.api.events.get({ calendarId: this.id, eventId: id, timeZone: this.tz })).data;
  }

  isBotEvent(ev) {
    return Boolean(ev.extendedProperties?.private?.[BOT_TAG]);
  }

  /** returns {result, undo} */
  async create(a) {
    const body = {
      summary: a.summary,
      location: a.location || undefined,
      description: a.description || undefined,
      ...buildTimeFields(a, this.tz, this.cfg.defaultReminderMinutes),
      extendedProperties: { private: { [BOT_TAG]: '1' } },
    };
    const ev = (await this.api.events.insert({ calendarId: this.id, requestBody: body })).data;
    return { result: compact(ev), undo: { op: 'delete', event_id: ev.id } };
  }

  async update(id, changes) {
    const before = await this.get(id);
    if (this.cfg.protectNonBotEvents && !this.isBotEvent(before)) {
      throw new Error(`האירוע "${before.summary}" לא נוצר ע"י הבוט ומוגן (protectNonBotEvents)`);
    }
    const body = {};
    for (const k of ['summary', 'location', 'description']) if (changes[k] !== undefined) body[k] = changes[k];
    const timeTouched = ['start', 'end', 'all_day', 'reminders_minutes'].some((k) => changes[k] !== undefined);
    if (timeTouched) {
      const cur = compact(before);
      const merged = {
        start: changes.start ?? cur.start,
        end: changes.end ?? (changes.start ? undefined : cur.end),
        all_day: changes.all_day ?? (changes.start ? undefined : cur.all_day === true),
        reminders_minutes: changes.reminders_minutes,
      };
      // If only start moved on a timed event, keep the original duration
      if (changes.start && !changes.end && !cur.all_day && before.start?.dateTime && !isDateOnly(changes.start)) {
        const dur = (new Date(before.end.dateTime) - new Date(before.start.dateTime)) / 60000;
        merged.end = addMinutes(changes.start, dur);
      }
      const tf = buildTimeFields(merged, this.tz, null);
      body.start = tf.start;
      body.end = tf.end;
      if (tf.reminders) body.reminders = tf.reminders;
    }
    const ev = (await this.api.events.patch({ calendarId: this.id, eventId: id, requestBody: body })).data;
    return { result: compact(ev), before: compact(before), undo: { op: 'restore', event_id: id, snapshot: snapshot(before) } };
  }

  async remove(id) {
    const before = await this.get(id);
    if (this.cfg.protectNonBotEvents && !this.isBotEvent(before)) {
      throw new Error(`האירוע "${before.summary}" לא נוצר ע"י הבוט ומוגן (protectNonBotEvents)`);
    }
    await this.api.events.delete({ calendarId: this.id, eventId: id });
    return { result: compact(before), undo: { op: 'recreate', snapshot: snapshot(before) } };
  }

  /** apply an inverse op from the undo stack */
  async applyUndo(u) {
    if (u.op === 'delete') {
      await this.api.events.delete({ calendarId: this.id, eventId: u.event_id });
    } else if (u.op === 'restore') {
      await this.api.events.patch({ calendarId: this.id, eventId: u.event_id, requestBody: u.snapshot });
    } else if (u.op === 'recreate') {
      await this.api.events.insert({ calendarId: this.id, requestBody: u.snapshot });
    }
  }
}
