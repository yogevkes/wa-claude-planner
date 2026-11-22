/** Timezone helpers that don't depend on the machine's local timezone */

function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return o;
}

export function localDate(date, tz) {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localDateTime(date, tz) {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function localHour(date, tz) {
  return Number(parts(date, tz).hour);
}

export function hebWeekday(date, tz) {
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, weekday: 'long' }).format(date);
}

/** "YYYY-MM-DD יום X" lines for the next n days — helps resolve "ביום שלישי הבא" */
export function dayTable(tz, n = 14, from = new Date()) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(from.getTime() + i * 86400000);
    lines.push(`${localDate(d, tz)} ${hebWeekday(d, tz)}${i === 0 ? ' (היום)' : i === 1 ? ' (מחר)' : ''}`);
  }
  return lines.join('\n');
}
