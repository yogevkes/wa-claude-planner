import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * "Which computer runs this bot" - so moving to a new computer stops the old one.
 *
 * The machine id lives in the Windows user profile, NOT in the project folder, so copying
 * the wa-claude folder (with data\ and the WhatsApp link) to a new computer does not copy it.
 * The current owner is recorded in the person's Google Calendar (a hidden all-day event in
 * the year 2000), because that is the one place every copy of the bot can read and write -
 * even when two computers share the same copied WhatsApp link, or use two different ones.
 */
export function machineIdentity(dir = path.join(os.homedir(), '.wa-claude-planner')) {
  const file = path.join(dir, 'machine-id');
  let id = '';
  try {
    id = fs.readFileSync(file, 'utf8').trim();
  } catch {
    /* first run on this computer */
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, id);
  }
  return { id, host: os.hostname() };
}

/** Google event ids allow only a-v and 0-9; one lease per instance */
export function leaseEventId(instance) {
  return `plannerlease${Buffer.from(String(instance).toLowerCase()).toString('hex')}`;
}

const is404 = (e) => e?.code === 404 || e?.status === 404 || e?.response?.status === 404 || /\b404\b|not found/i.test(e?.message || '');

export class OwnerLease {
  constructor({ api, calendarId = 'primary', instance = 'default', machine }) {
    Object.assign(this, { api, calendarId, machine });
    this.eventId = leaseEventId(instance);
  }

  /** @returns {Promise<{owner:string, host:string, since:string}|null>} null = nobody claimed yet */
  async read() {
    let ev;
    try {
      ev = (await this.api.events.get({ calendarId: this.calendarId, eventId: this.eventId })).data;
    } catch (e) {
      if (is404(e)) return null;
      throw e;
    }
    const p = ev?.extendedProperties?.private || {};
    if (ev?.status === 'cancelled' || !p.waClaudeOwner) return null;
    return { owner: p.waClaudeOwner, host: p.waClaudeHost || '', since: p.waClaudeSince || '' };
  }

  /** Make this computer the owner. Returns the previous owner (or null) */
  async claim() {
    const previous = await this.read().catch(() => null);
    const body = {
      summary: 'WA-Claude Planner – המחשב הפעיל (לא למחוק)',
      description: 'רשומה טכנית של הבוט: באיזה מחשב הוא פועל. כשמפעילים את הבוט במחשב חדש, הישן מפסיק לפעול.',
      start: { date: '2000-01-01' },
      end: { date: '2000-01-02' },
      transparency: 'transparent',
      visibility: 'private',
      status: 'confirmed',
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: {
        private: { waClaudeOwner: this.machine.id, waClaudeHost: this.machine.host, waClaudeSince: new Date().toISOString() },
      },
    };
    try {
      await this.api.events.update({ calendarId: this.calendarId, eventId: this.eventId, requestBody: body });
    } catch (e) {
      if (!is404(e)) throw e;
      await this.api.events.insert({ calendarId: this.calendarId, requestBody: { id: this.eventId, ...body } });
    }
    return previous;
  }
}

/**
 * Keeps exactly one computer running the bot.
 * start(): first run on this computer (new install, or the folder was copied here), --take-over,
 *          or nobody claimed yet -> claim. Another computer claimed after us -> retire.
 * check(): called periodically, before every job and when WhatsApp says another connection
 *          replaced ours. If another computer has claimed since, retire.
 * Google unreachable never stops the bot; a claim that failed is retried by check().
 */
export class OwnershipGuard {
  constructor({ lease, state, machine, log, onRetire, onClaim, minIntervalMs = 20000 }) {
    Object.assign(this, { lease, state, machine, log, onRetire, onClaim, minIntervalMs });
    this.pendingClaim = false;
    this.retired = false;
    this.lastCheck = 0;
    this.inFlight = null;
  }

  /** @returns {Promise<'run'|'retire'>} */
  async start({ takeOver = false } = {}) {
    const firstRunHere = this.state.d.machineId !== this.machine.id;
    let current;
    try {
      current = await this.lease.read();
    } catch (e) {
      this.log?.warn({ err: e }, 'could not read which computer runs the bot');
      if (!firstRunHere && !takeOver) return 'run';
    }
    if (firstRunHere || takeOver || current === null) {
      this.pendingClaim = true;
      await this.tryClaim();
      return 'run';
    }
    if (current && current.owner !== this.machine.id) return this.retire(current);
    return 'run';
  }

  async tryClaim() {
    try {
      const previous = await this.lease.claim();
      this.pendingClaim = false;
      this.state.d.machineId = this.machine.id;
      this.state.save();
      this.log?.info({ host: this.machine.host, previous: previous?.host }, 'this computer now runs the bot');
      await this.onClaim?.(previous);
      return true;
    } catch (e) {
      this.log?.warn({ err: e }, 'could not record this computer as the active one, will retry');
      return false;
    }
  }

  /** @returns {Promise<boolean>} true = keep working here */
  check({ force = false } = {}) {
    if (this.retired) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    if (!force && Date.now() - this.lastCheck < this.minIntervalMs) return Promise.resolve(true);
    this.inFlight = (async () => {
      try {
        if (this.pendingClaim) {
          await this.tryClaim();
          return true;
        }
        const current = await this.lease.read();
        if (current && current.owner !== this.machine.id) return (await this.retire(current)) !== 'retire';
        if (current === null) {
          this.pendingClaim = true; // the record was deleted - claim it back
          await this.tryClaim();
        }
        return true;
      } catch (e) {
        this.log?.warn({ err: e }, 'ownership check failed, continuing');
        return true;
      } finally {
        this.lastCheck = Date.now();
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  async retire(current) {
    this.retired = true;
    this.log?.warn(
      { activeHost: current.host, since: current.since },
      `The bot now runs on another computer (${current.host || '?'}). Stopping here. To move it back to this computer run windows\\take-over.bat`,
    );
    await this.onRetire?.(current);
    return 'retire';
  }
}

/** Hebrew line announcing the move (or '' when there is nothing to announce) */
export function takeoverMessage(previous, machine) {
  if (!previous || previous.owner === machine.id) return '';
  const old = previous.host ? ` (${previous.host})` : '';
  return `💻 הבוט פועל עכשיו מהמחשב ${machine.host}. המחשב הקודם${old} הפסיק לפעול.`;
}
