import { localDateTime, hebWeekday, dayTable } from './time.js';

const SCHEMA = `{
  "calendar_actions": [
    {"op": "create", "summary": "...", "start": "YYYY-MM-DDTHH:mm" | "YYYY-MM-DD", "end": "YYYY-MM-DDTHH:mm" | "YYYY-MM-DD" | null,
     "all_day": false, "location": "..." | null, "description": "..." | null, "reminders_minutes": [30] | null},
    {"op": "update", "event_id": "<id from the calendar list>", "changes": {"summary"?: "...", "start"?: "...", "end"?: "...", "all_day"?: bool, "location"?: "...", "description"?: "...", "reminders_minutes"?: [..]}},
    {"op": "delete", "event_id": "<id from the calendar list>"}
  ],
  "task_actions": [
    {"op": "add", "text": "...", "due": "YYYY-MM-DD" | null},
    {"op": "done", "id": <task id>},
    {"op": "remove", "id": <task id>}
  ],
  "reply": "WhatsApp message in Hebrew" | null
}`;

function header(ctx) {
  const { cfg, now } = ctx;
  return `You are the personal schedule manager of the user. The user writes notes to themself in a private WhatsApp group; you read them, keep their Google Calendar and task list up to date, and reply in that same group.

Current time: ${localDateTime(now, cfg.timezone)} (${hebWeekday(now, cfg.timezone)}), timezone ${cfg.timezone}.
Upcoming days:
${dayTable(cfg.timezone, 14, now)}

About the user (written by them):
${cfg.userContext || '(none)'}`;
}

function context(ctx) {
  const tasks = ctx.tasks.filter((t) => !t.done);
  const hist = ctx.history
    .map((h) => `[${h.when}] ${h.role === 'me' ? 'USER' : 'YOU'}: ${h.text}`)
    .join('\n');
  return `
=== GOOGLE CALENDAR (${ctx.events.length} events, times are local) ===
${ctx.events.length ? ctx.events.map((e) => JSON.stringify(e)).join('\n') : '(empty)'}

=== OPEN TASKS ===
${tasks.length ? tasks.map((t) => JSON.stringify({ id: t.id, text: t.text, due: t.due || null })).join('\n') : '(none)'}

=== RECENT CONVERSATION IN THE GROUP (oldest first) ===
${hist || '(none)'}`;
}

export function buildMessagePrompt(ctx, newMessages) {
  const msgs = newMessages
    .map((m) => {
      let s = `[sent ${m.when}] ${m.text || ''}`;
      if (m.mediaFile) s += `\n  (attached file: ./${m.mediaFile} — open it with the Read tool and use its content)`;
      if (m.note) s += `\n  (${m.note})`;
      return s;
    })
    .join('\n');

  return `${header(ctx)}
${context(ctx)}

=== NEW MESSAGES FROM THE USER (handle these now) ===
${msgs}

=== HOW TO HANDLE THEM ===
1. Resolve relative dates ("מחר", "ביום שלישי", "בעוד שבוע") relative to the time each message was SENT, not the current time (some messages may be hours old).
2. A meeting / appointment / event / deadline with a date → calendar "create". Use a short clear Hebrew summary. Put useful details (who, phone, link, what to bring) in description.
   - If the date is known but a time is clearly needed and missing, do NOT guess: ask in the reply instead, and don't create it yet. Things that are naturally all-day (birthday, trip, holiday, deadline day) → all_day with start date (and end = last day, inclusive).
   - Timed event without a stated end → leave end null (1 hour default) unless the type obviously implies another length.
   - Before creating, check the calendar list for an existing matching event — never create duplicates; update it instead.
3. Changes / postponements / cancellations → "update" / "delete" using the exact event_id from the calendar list. If it's ambiguous which event is meant, ask instead of guessing.
4. Things to do without a specific time ("להתקשר ל...", "לקנות...") → task "add" (with due date if one is implied). When the user says something is done → task "done". Don't add tasks that duplicate open ones.
5. Images / PDFs (invitations, screenshots, appointment confirmations) → read them and extract events/tasks.
6. Answer questions about the schedule ("מה יש לי מחר?", "מתי אני פנוי השבוע?") from the calendar list.
7. Look for real insights and say them only when they matter: conflicts/overlaps, too-tight transitions or travel time, an event that needs preparation, an overloaded day, an overdue task, something the user said they'd do with no slot for it.
8. "reply": short, warm, practical Hebrew suitable for WhatsApp (use *bold* sparingly, simple "•" bullets, no markdown headers, no tables). Do NOT list the calendar/task changes you made — the system automatically appends a confirmation of every executed action. Use reply for insights, warnings, questions and direct answers. Use null if there is truly nothing to add.
9. If a message isn't about scheduling at all (a thought, a link, a feeling), don't force an action; a brief acknowledgement or a useful remark is enough.

Answer with ONLY a JSON object in exactly this shape (empty arrays when nothing to do), no other text:
${SCHEMA}`;
}

export function buildScanPrompt(ctx, pending, when) {
  const chats = pending
    .map((p) => {
      const line = (m, withFile) =>
        `  [${when(m.ts)}] ${m.sender}: ${m.text || ''}${m.note ? ` (${m.note})` : ''}` +
        (withFile && m.mediaFile ? `\n    (attached: ./${m.mediaFile} — open it with the Read tool)` : '');
      return `--- CHAT: "${p.name}" ---
${p.context.length ? `Earlier (already reviewed, context only):\n${p.context.map((m) => line(m, false)).join('\n')}\n` : ''}NEW since last check${p.omitted ? ` (${p.omitted} older new messages omitted)` : ''}:
${p.fresh.map((m) => line(m, true)).join('\n')}`;
    })
    .join('\n\n');

  return `${header(ctx)}
${context(ctx)}

=== TASK: HOURLY CHECK OF THE USER'S IMPORTANT CHATS ===
Below are new messages from WhatsApp chats the user asked you to watch (family, partner, mother, a lawyer). "אני" = the user himself.
Decide, per chat, whether the new messages require ACTION or COORDINATION from the user: an unanswered question to him, a request, a decision to make, something to schedule or reschedule, a deadline, a document to send, something to buy/bring/pay, a pickup or logistics to coordinate, or a conflict with his calendar.

${chats}

=== RULES ===
0. Attached images/PDFs: open EVERY attached file with the Read tool before deciding. Look for actionable content: invitations, schedules, school/kindergarten notices, appointment confirmations, bills, forms, legal documents, screenshots of messages, handwritten notes, lists. Ordinary photos (people, kids, food, scenery, memes) need no action — skip them silently.
1. If the user already replied after the message and nothing is left open, it's handled — skip it. Chit-chat, photos, jokes, greetings and FYI with nothing to do → skip.
2. Check every date/time mentioned against the calendar above: say if it conflicts or is already in the calendar.
3. NEVER change the calendar yourself in this check: calendar_actions must be []. When something should go into the calendar, SUGGEST it in the reply with exact title, day, date and time (e.g. "📅 להוסיף: אסיפת הורים – יום ג׳ 25.11 18:00?") so the user can answer "כן" in the group.
4. You MAY add follow-up tasks to the task list (task_actions "add") for clear things the user has to do, e.g. "לענות לאמא לגבי שישי". Don't duplicate open tasks; mark a task "done" if the chat shows it was handled.
5. When a reply is needed, you may propose a short suggested reply text in Hebrew, in the user's voice, that he can copy (prefix it with "✍️ הצעה לתשובה:").
6. "reply": a short WhatsApp message in Hebrew grouped by chat, most urgent first:
   *שם השיחה*: what's needed in one line → suggestion / reply draft
   Only include chats that need something. Don't repeat items you already reported in the recent group conversation unless something changed or it became urgent.
7. If NOTHING needs action or coordination, return "reply": null (the user gets no message this hour).

Answer with ONLY a JSON object in exactly this shape, no other text:
${SCHEMA}`;
}

export function buildBriefPrompt(ctx, kind) {
  const what =
    kind === 'morning'
      ? `Write the user's MORNING BRIEF for today: today's schedule in order (times + titles), what to prepare or bring, conflicts or tight transitions, tasks due today or overdue, and 1-2 concrete suggestions for using free slots for open tasks. Briefly mention anything notable tomorrow.`
      : `Write the user's END-OF-DAY SUMMARY, in two parts:
1. *סיכום היום* – what today's calendar had, tasks completed today (listed below), what was added/changed today according to the conversation, and what was left open or slipped (overdue tasks). One short encouraging line if the day went well.
2. *מחר* – tomorrow in order (times + titles, first commitment and when to leave/wake if relevant), what to prepare tonight, and anything notable later this week.

Tasks completed today:
${(ctx.doneToday || []).map((t) => `• ${t.text}`).join('\n') || '(none)'}`;
  return `${header(ctx)}
${context(ctx)}

=== TASK ===
${what}
Keep it short and scannable for WhatsApp, in Hebrew (*bold* sparingly, "•" bullets, no markdown headers). If the day is empty, say so in one line and suggest something useful from the open tasks.
Do not change anything — return empty action arrays.

Answer with ONLY a JSON object in exactly this shape, no other text:
${SCHEMA}`;
}
