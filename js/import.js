// Parse a simple, human-readable (and Claude-generatable) block into many
// entries at once, so details can be added in bulk by pasting instead of typing
// each form. One item per line: "type: field | field | field".

const num = (s) => parseFloat(s) || 0;
function iso(s) {
  if (!s) return '';
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

/** @returns grouped entries plus any lines that couldn't be understood. */
export function parseImport(text) {
  const r = { subscriptions: [], utilities: [], documents: [], deliveries: [], loyalty: [], checkups: [], maintenance: [], shopping: [], vehicle: {}, errors: [] };
  const lines = (text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const line of lines) {
    const m = line.match(/^([a-z][a-z \-]*):\s*(.*)$/i);
    if (!m) { r.errors.push(line); continue; }
    const type = m[1].trim().toLowerCase();
    const p = m[2].split('|').map((s) => s.trim());
    switch (type) {
      case 'subscription': r.subscriptions.push({ name: p[0], cost: num(p[1]), cycle: (p[2] || 'monthly').toLowerCase(), renewal: iso(p[3]) }); break;
      case 'utility': r.utilities.push({ type: p[0], provider: p[1] || '', cost: num(p[2]), renewal: iso(p[3]), tariff: p[4] || '', usage: p[5] || '' }); break;
      case 'document': r.documents.push({ label: p[0], category: p[1] || 'Other', expiry: iso(p[2]), note: p[3] || '' }); break;
      case 'delivery': r.deliveries.push({ item: p[0], carrier: p[1] || 'Other', tracking: p[2] || '', expected: iso(p[3]) }); break;
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
    Object.keys(r.vehicle).length
  );
}
