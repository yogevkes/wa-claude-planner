import { buildMessagePrompt, buildBriefPrompt, buildScanPrompt } from './prompts.js';
import { fmtWhen, fmtDue } from './format.js';
import { localDateTime, localDate, localHour } from './time.js';

const COMMANDS = {
  help: ['/help', '/עזרה'],
  undo: ['/undo', '/בטל'],
  status: ['/status', '/סטטוס'],
  morning: ['/brief', '/בוקר'],
  evening: ['/evening', '/ערב'],
  tasks: ['/tasks', '/משימות'],
  retry: ['/retry', '/שוב'],
  scan: ['/scan', '/סרוק'],
  chats: ['/chats', '/שיחות'],
};

const HELP = `פקודות:
• /משימות – רשימת המשימות הפתוחות
• /בטל – ביטול הפעולה האחרונה ביומן/משימות
• /בוקר – סיכום בוקר עכשיו
• /ערב – סיכום יום + תכנון מחר עכשיו
• /סרוק – לבדוק עכשיו את השיחות במעקב
• /שיחות – אילו שיחות במעקב וכמה הודעות חדשות
• /שוב – לנסות שוב הודעה שנכשלה
• /סטטוס – מצב הבוט
כל הודעה אחרת עוברת ל-Claude: פגישות, תזכורות, שינויים, שאלות על הלו"ז, צילומי הזמנות.`;

export class Processor {
  /**
   * @param {object} o
   * @param {object} o.cfg
   * @param {import('./state.js').State} o.state
   * @param {object} o.calendar  Calendar-like: listWindow, create, update, remove, applyUndo
   * @param {(text:string)=>Promise<void>} o.send
   * @param {(prompt:string)=>Promise<object>} o.ask  returns normalized decision
   */
  constructor({ cfg, state, calendar, send, ask, log, inbox, guard, hostName }) {
    Object.assign(this, { cfg, state, calendar, send, ask, log, inbox, guard, hostName });
    this.pending = [];
    this.timer = null;
    this.chain = Promise.resolve();
    this.startedAt = new Date();
  }

  get s() {
    return this.state.d;
  }

  /** queue work so batches/briefs never run concurrently */
  run(fn) {
    // guard: only the computer that currently owns the bot may answer / touch the calendar
    const job = async () => (this.guard && !(await this.guard()) ? undefined : fn());
    this.chain = this.chain.then(job).catch((e) => this.log?.error({ err: e }, 'queued job failed'));
    return this.chain;
  }

  /** @param {{id:string, ts:number, text:string, mediaFile?:string, note?:string}} msg */
  enqueue(msg) {
    const cmd = this.commandOf(msg.text);
    if (cmd) {
      this.markSeen([msg]);
      return this.run(() => this.handleCommand(cmd));
    }
    this.pending.push(msg);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), (this.cfg.debounceSec ?? 15) * 1000);
  }

  flush() {
    clearTimeout(this.timer);
    if (!this.pending.length) return this.chain;
    const batch = this.pending.sort((a, b) => a.ts - b.ts);
    this.pending = [];
    return this.run(() => this.processBatch(batch));
  }

  commandOf(text) {
    const first = (text || '').trim().split(/\s+/)[0]?.toLowerCase();
    if (!first?.startsWith('/')) return null;
    return Object.keys(COMMANDS).find((k) => COMMANDS[k].includes(first)) || null;
  }

  markSeen(batch) {
    for (const m of batch) {
      this.s.processedIds.push(m.id);
      this.s.lastSeenTs = Math.max(this.s.lastSeenTs || 0, m.ts);
    }
    this.state.save();
  }

  when(ts) {
    return localDateTime(new Date(ts * 1000), this.cfg.timezone);
  }

  async buildContext() {
    const events = await this.calendar.listWindow();
    const n = this.cfg.historyMessages ?? 30;
    return {
      cfg: this.cfg,
      now: new Date(),
      events,
      tasks: this.s.tasks,
      history: this.s.history.slice(-n),
    };
  }

  async processBatch(batch) {
    this.log?.info({ count: batch.length }, 'processing batch');
    try {
      const ctx = await this.buildContext();
      const prompt = buildMessagePrompt(ctx, batch.map((m) => ({ ...m, when: this.when(m.ts) })));
      const decision = await this.ask(prompt);
      const { lines, undo } = await this.execute(decision);

      for (const m of batch) {
        const t = [m.text, m.mediaFile ? '[קובץ מצורף]' : '', m.note ? `[${m.note}]` : ''].filter(Boolean).join(' ');
        this.s.history.push({ role: 'me', ts: m.ts, when: this.when(m.ts), text: t.slice(0, 1000) });
      }
      const reply = [decision.reply, lines.join('\n')].filter(Boolean).join('\n\n');
      if (undo) this.s.undoStack.push(undo);
      this.s.failedBatch = null;
      this.markSeen(batch);
      if (reply) await this.reply(reply);
    } catch (e) {
      this.log?.error({ err: e }, 'batch failed');
      this.s.failedBatch = batch;
      this.markSeen(batch);
      await this.reply(`⚠️ לא הצלחתי לעבד את ההודעה: ${String(e.message).slice(0, 200)}\nשלח /שוב כדי לנסות שוב.`);
    }
  }

  async reply(text) {
    const now = Math.floor(Date.now() / 1000);
    this.s.history.push({ role: 'bot', ts: now, when: this.when(now), text: text.slice(0, 1500) });
    this.state.save();
    await this.send(text);
  }

  /** run calendar + task actions; returns confirmation lines and an undo record */
  async execute(decision) {
    const lines = [];
    const calUndo = [];
    for (const a of decision.calendar_actions) {
      try {
        if (a.op === 'create') {
          const r = await this.calendar.create(a);
          calUndo.push(r.undo);
          lines.push(`✅ נוסף ליומן: *${r.result.summary}* – ${fmtWhen(r.result)}`);
        } else if (a.op === 'update') {
          const r = await this.calendar.update(a.event_id, a.changes || {});
          calUndo.push(r.undo);
          const moved = fmtWhen(r.before) !== fmtWhen(r.result) ? ` → ${fmtWhen(r.result)}` : '';
          lines.push(`✏️ עודכן: *${r.result.summary}*${moved || ` – ${fmtWhen(r.result)}`}`);
        } else if (a.op === 'delete') {
          const r = await this.calendar.remove(a.event_id);
          calUndo.push(r.undo);
          lines.push(`🗑️ נמחק מהיומן: *${r.result.summary}* – ${fmtWhen(r.result)}`);
        }
      } catch (e) {
        this.log?.warn({ err: e, action: a }, 'calendar action failed');
        lines.push(`⚠️ לא הצלחתי (${a.op} ${a.summary || a.event_id || ''}): ${String(e.message).slice(0, 150)}`);
      }
    }

    const tasksBefore = structuredClone(this.s.tasks);
    const nextIdBefore = this.s.nextTaskId;
    let tasksChanged = false;
    for (const t of decision.task_actions) {
      if (t.op === 'add' && t.text) {
        const task = { id: this.s.nextTaskId++, text: String(t.text), due: t.due || null, done: false, createdTs: Math.floor(Date.now() / 1000) };
        this.s.tasks.push(task);
        lines.push(`📝 משימה: ${task.text}${fmtDue(task.due)}`);
        tasksChanged = true;
      } else if (t.op === 'done' || t.op === 'remove') {
        const task = this.s.tasks.find((x) => x.id === Number(t.id));
        if (!task) continue;
        if (t.op === 'done') {
          task.done = true;
          task.doneTs = Math.floor(Date.now() / 1000);
          lines.push(`☑️ בוצע: ${task.text}`);
        } else {
          this.s.tasks = this.s.tasks.filter((x) => x !== task);
          lines.push(`🗑️ משימה הוסרה: ${task.text}`);
        }
        tasksChanged = true;
      }
    }

    const undo =
      calUndo.length || tasksChanged
        ? {
            ts: Math.floor(Date.now() / 1000),
            label: lines.filter((l) => !l.startsWith('⚠️')).join('\n'),
            calendar: calUndo.reverse(),
            tasksBefore: tasksChanged ? tasksBefore : null,
            nextTaskIdBefore: tasksChanged ? nextIdBefore : null,
          }
        : null;
    return { lines, undo };
  }

  async handleCommand(cmd) {
    switch (cmd) {
      case 'help':
        return this.reply(HELP);
      case 'tasks': {
        const open = this.s.tasks.filter((t) => !t.done);
        return this.reply(open.length ? `משימות פתוחות:\n${open.map((t) => `• ${t.text}${fmtDue(t.due)}`).join('\n')}` : 'אין משימות פתוחות 🎉');
      }
      case 'status':
        return this.reply(
          `פעיל מאז ${localDateTime(this.startedAt, this.cfg.timezone)}${this.hostName ? `\nמחשב: ${this.hostName}` : ''}\nמשימות פתוחות: ${this.s.tasks.filter((t) => !t.done).length}\nפעולות שאפשר לבטל: ${this.s.undoStack.length}${this.s.failedBatch ? '\nיש הודעה שנכשלה – /שוב' : ''}`,
        );
      case 'undo':
        return this.undo();
      case 'retry':
        if (!this.s.failedBatch) return this.reply('אין הודעה שנכשלה.');
        return this.processBatch(this.s.failedBatch);
      case 'morning':
      case 'evening':
        return this.brief(cmd, true);
      case 'scan':
        return this.scan(true);
      case 'chats': {
        const watched = (this.cfg.watchChats || []).map((e) => (typeof e === 'string' ? e : e.name));
        const st = new Map((this.inbox?.stats() || []).map((x) => [x.name, x]));
        const lines = watched.map((n) => {
          const x = st.get(n);
          return x ? `• ${n}: ${x.unscanned} חדשות` : `• ${n}: ❔ עוד לא התקבלו הודעות (אם זה נמשך – בדוק שם/טלפון בקונפיג)`;
        });
        return this.reply(`שיחות במעקב:\n${lines.join('\n')}`);
      }
    }
  }

  async undo() {
    const u = this.s.undoStack.pop();
    if (!u) return this.reply('אין מה לבטל.');
    const errors = [];
    for (const op of u.calendar) {
      try {
        await this.calendar.applyUndo(op);
      } catch (e) {
        errors.push(String(e.message).slice(0, 120));
      }
    }
    if (u.tasksBefore) {
      this.s.tasks = u.tasksBefore;
      this.s.nextTaskId = u.nextTaskIdBefore;
    }
    this.state.save();
    return this.reply(`↩️ בוטל:\n${u.label}${errors.length ? `\n⚠️ חלק לא בוטל: ${errors.join('; ')}` : ''}`);
  }

  inQuietHours(date = new Date()) {
    const [from, to] = this.cfg.scanQuietHours || [];
    if (from == null || to == null) return false;
    const h = localHour(date, this.cfg.timezone);
    return from > to ? h >= from || h < to : h >= from && h < to;
  }

  /** Hourly check of the watched chats: report only what needs action/coordination */
  async scan(manual = false) {
    if (!this.inbox) return manual ? this.reply('אין שיחות במעקב (watchChats ריק).') : undefined;
    if (!manual && this.inQuietHours()) return;
    const pending = this.inbox
      .pending({ contextCount: this.cfg.scanContextMessages ?? 10 })
      .map((p) => ({ ...p, fresh: p.fresh.map((m) => ({ ...m })) })); // copies: the cap below must not touch the stored inbox
    if (!pending.length) return manual ? this.reply('אין הודעות חדשות בשיחות במעקב.') : undefined;
    this.log?.info({ chats: pending.map((p) => `${p.name}:${p.fresh.length}`) }, 'scanning watched chats');
    // Cap how many images/PDFs Claude opens in one check (newest first), so a burst of photos can't time it out
    const maxFiles = this.cfg.scanMaxFiles ?? 12;
    const withFiles = pending.flatMap((p) => p.fresh.filter((m) => m.mediaFile)).sort((a, b) => b.ts - a.ts);
    for (const m of withFiles.slice(maxFiles)) {
      Object.assign(m, { mediaFile: undefined, note: [m.note, 'לא נפתח – יותר מדי קבצים בשעה הזו'].filter(Boolean).join(', ') });
    }
    try {
      const ctx = await this.buildContext();
      const d = await this.ask(buildScanPrompt(ctx, pending, (ts) => this.when(ts)));
      d.calendar_actions = []; // calendar changes only after the user approves in the group
      const { lines, undo } = await this.execute(d);
      if (undo) this.s.undoStack.push(undo);
      this.inbox.markScanned(pending);
      const text = [d.reply, lines.join('\n')].filter(Boolean).join('\n\n');
      if (text) await this.reply(`🔎 ${text}`);
      else if (manual) await this.reply('בדקתי – אין משהו שדורש פעולה ממך.');
      else this.state.save();
    } catch (e) {
      this.log?.error({ err: e }, 'scan failed'); // inbox not marked: next hour retries
      if (manual) await this.reply(`⚠️ הבדיקה נכשלה: ${String(e.message).slice(0, 200)}`);
    }
  }

  async brief(kind, manual = false) {
    const today = localDate(new Date(), this.cfg.timezone);
    if (!manual && this.s.lastBriefs[kind] === today) return;
    try {
      const ctx = await this.buildContext();
      ctx.doneToday = this.s.tasks.filter(
        (t) => t.done && t.doneTs && localDate(new Date(t.doneTs * 1000), this.cfg.timezone) === today,
      );
      const d = await this.ask(buildBriefPrompt(ctx, kind));
      this.s.lastBriefs[kind] = today;
      await this.reply(d.reply || (kind === 'morning' ? 'בוקר טוב! אין אירועים היום.' : 'אין אירועים מחר.'));
    } catch (e) {
      this.log?.error({ err: e }, 'brief failed');
      if (manual) await this.reply(`⚠️ לא הצלחתי להכין סיכום: ${String(e.message).slice(0, 200)}`);
    }
  }
}
