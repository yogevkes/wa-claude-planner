const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

function dayLabel(dateStr) {
  const d = new Date(`${dateStr.slice(0, 10)}T12:00:00Z`);
  const [, m, day] = dateStr.slice(0, 10).split('-');
  return `יום ${DAYS[d.getUTCDay()]} ${Number(day)}.${Number(m)}`;
}

/** compact event -> "יום ג׳ 25.11 10:00–11:00" */
export function fmtWhen(ev) {
  if (!ev?.start) return '';
  if (ev.all_day || ev.start.length === 10) {
    const end = ev.end && ev.end.slice(0, 10) !== ev.start.slice(0, 10) ? ` עד ${dayLabel(ev.end)}` : '';
    return `${dayLabel(ev.start)}${end} (כל היום)`;
  }
  const st = ev.start.slice(11, 16);
  const sameDay = ev.end && ev.end.slice(0, 10) === ev.start.slice(0, 10);
  const en = ev.end ? (sameDay ? ev.end.slice(11, 16) : `${dayLabel(ev.end)} ${ev.end.slice(11, 16)}`) : '';
  return `${dayLabel(ev.start)} ${st}${en ? `–${en}` : ''}`;
}

export function fmtDue(due) {
  return due ? ` (עד ${dayLabel(due)})` : '';
}
