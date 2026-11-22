/** Normalize chat/contact names so small differences (spaces, Hebrew quote marks) still match */
export function normName(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/[״“”]/g, '"') // ״ “ ” -> "
    .replace(/[׳‘’]/g, "'") // ׳ ‘ ’ -> '
    .replace(/[​-‏‪-‮⁦-⁩️]/g, '') // invisible direction marks / emoji variation selector
    .replace(/\s+/g, ' ')
    .trim();
}

const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * Watch list entries may be a plain name string, or {name, phone?, jid?}.
 * Returns a matcher: (chat) => watch key (the configured name) or null.
 */
export function makeWatchMatcher(entries = []) {
  const list = entries.map((e) => (typeof e === 'string' ? { name: e } : e)).filter((e) => e?.name);
  const byName = new Map(list.map((e) => [normName(e.name), e.name]));
  const byJid = new Map();
  for (const e of list) {
    if (e.jid) byJid.set(e.jid, e.name);
    if (e.phone) byJid.set(`${digits(e.phone)}@s.whatsapp.net`, e.name);
  }
  return {
    entries: list,
    /** @param {{jids: string[], name?: string}} chat */
    match({ jids = [], name }) {
      for (const j of jids) if (j && byJid.has(j)) return byJid.get(j);
      if (name && byName.has(normName(name))) return byName.get(normName(name));
      return null;
    },
  };
}
