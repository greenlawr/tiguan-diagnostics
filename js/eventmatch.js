// Spot the same event appearing more than once — e.g. an invite that's in both
// your calendars, or an old copy with slightly different wording — so the
// family calendar can show it once.

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'at', 'in', 'on', 'for', 'with', 'by', 'from', 'reminder', 'event']);

/** Meaningful words in a title (lower-case, no punctuation/emoji, no bare times or small numbers). */
export function titleWords(title) {
  return new Set(String(title || '').toLowerCase().normalize('NFKD')
    .replace(/[‘’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d{1,2}$/.test(w) && !/^\d{1,2}(am|pm)$/.test(w) && !/^\d{3,4}$/.test(w)));
}

/** Titles that clearly describe the same thing ("Bins out: blue bin" vs "🗑️ Bin Reminder: Blue bin"). */
export function similarTitles(a, b) {
  const A = titleWords(a), B = titleWords(b);
  if (!A.size || !B.size) return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  let shared = 0;
  for (const w of A) if (B.has(w) || B.has(w.replace(/s$/, '')) || B.has(w + 's')) shared++;
  const smaller = Math.min(A.size, B.size);
  return shared / smaller >= 0.6 && shared >= Math.min(2, smaller);
}

/** Same day, same time (or both all-day), similar title. Birthdays from Family never merge. */
export function sameEvent(a, b) {
  if (a.virtual || b.virtual) return false;
  return a.date === b.date && (a.time || '') === (b.time || '') && similarTitles(a.title, b.title);
}

/**
 * Collapse matching events into one row. A copy from a connected calendar is
 * preferred over one added by link/hand; if two people's calendars both have
 * it, the row is marked `who: 'Both'` with `people` listing them.
 */
export function groupEvents(rows) {
  const groups = [];
  for (const r of rows) {
    const g = groups.find((x) => sameEvent(x[0], r));
    if (g) g.push(r); else groups.push([r]);
  }
  return groups.map((members) => {
    if (members.length === 1) return members[0];
    const fromCalendars = members.filter((m) => m.src);
    const base = fromCalendars[0] || members[0];
    const people = [...new Set(fromCalendars.map((m) => m.who).filter(Boolean))];
    return { ...base, who: people.length >= 2 ? 'Both' : base.who, people, members };
  });
}
