// Parse a simple, human-readable (and Claude-generatable) block into many
// entries at once, so details can be added in bulk by pasting instead of typing
// each form. One item per line: "type: field | field | field".

const num = (s) => parseFloat(s) || 0;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** Dates the UK way: 2026-03-05, 05/03/2026 (day first), 5 March 2026, March 5th 2026. No time-zone shifts. */
export function iso(s) {
  if (!s) return '';
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  let day, mon, yr;
  for (const w of t.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').split(/[\s,]+/)) {
    if (/^\d{4}$/.test(w)) yr = +w;
    else if (/^\d{1,2}$/.test(w)) day = +w;
    else if (MONTHS.includes(w.slice(0, 3))) mon = MONTHS.indexOf(w.slice(0, 3)) + 1;
  }
  return day && mon && yr ? ymd(yr, mon, day) : '';
}
const cycle = (c) => { const w = (c || '').toLowerCase(); return /year|annual|yr/.test(w) ? 'yearly' : /week/.test(w) ? 'weekly' : 'monthly'; };

/** @returns grouped entries plus any lines that couldn't be understood. */
export function parseImport(text) {
  const r = { subscriptions: [], utilities: [], documents: [], deliveries: [], loyalty: [], checkups: [], maintenance: [], shopping: [], events: [], vehicle: {}, errors: [] };
  const lines = (text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const line of lines) {
    const m = line.match(/^([a-z][a-z \-]*):\s*(.*)$/i);
    if (!m) { r.errors.push(line); continue; }
    const type = m[1].trim().toLowerCase();
    const p = m[2].split('|').map((s) => s.trim());
    switch (type) {
      case 'subscription': r.subscriptions.push({ name: p[0], cost: num(p[1]), cycle: cycle(p[2]), renewal: iso(p[3]) }); break;
      case 'utility': r.utilities.push({ type: p[0], provider: p[1] || '', cost: num(p[2]), renewal: iso(p[3]), tariff: p[4] || '', usage: p[5] || '' }); break;
      case 'document': r.documents.push({ label: p[0], category: p[1] || 'Other', expiry: iso(p[2]), note: p[3] || '' }); break;
      case 'delivery': r.deliveries.push({ item: p[0], carrier: p[1] || 'Other', tracking: p[2] || '', expected: iso(p[3]) }); break;
      case 'event': r.events.push({ title: p[0], date: iso(p[1]), time: p[2] || '', where: p[3] || '' }); break;
      case 'loyalty': r.loyalty.push({ name: p[0], number: p[1] || '' }); break;
      case 'checkup': r.checkups.push({ type: p[0], last: iso(p[1]), interval: parseInt(p[2], 10) || 0 }); break;
      case 'maintenance': r.maintenance.push({ task: p[0], date: iso(p[1]) }); break;
      case 'shopping': for (const item of p.join('|').split(',').map((s) => s.trim()).filter(Boolean)) r.shopping.push(item); break;
      case 'reg': case 'registration': r.vehicle.reg = p[0]; break;
      case 'mot': r.vehicle.mot = iso(p[0]); break;
      case 'tax': case 'road tax': r.vehicle.tax = iso(p[0]); break;
      case 'insurance': r.vehicle.insurance = iso(p[0]); break;
      case 'service': r.vehicle.service = iso(p[0]); break;
      default: r.errors.push(line);
    }
  }
  return r;
}

/** Total number of items that would be added. */
export function importCount(r) {
  return (
    r.subscriptions.length + r.utilities.length + r.documents.length + r.deliveries.length +
    r.loyalty.length + r.checkups.length + r.maintenance.length + r.shopping.length +
    r.events.length + Object.keys(r.vehicle).length
  );
}
