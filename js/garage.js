// "Car hub" — everyday ownership tools that work with no car connection:
// fuel log + real MPG, service history, renewal reminders, where-I-parked,
// and a mileage log. All of it is pure logic here; storage and UI live in app.js.

export const UK_GALLON = 4.54609; // litres
const MILE = 1.609344; // km

// ---------- fuel economy ----------
// UK method: between two FULL fill-ups, mpg = miles driven / gallons put in to
// fill back up. Partial fill-ups in between still count toward the fuel used.

/**
 * @param fillups array of { date, odo (miles), litres, cost (£), full (bool) }
 * @returns { segments, latestMpg, avgMpg, totalSpend, totalLitres, lastPricePerLitre }
 */
export function fuelStats(fillups) {
  const rows = [...fillups].filter((f) => f.odo > 0 && f.litres > 0).sort((a, b) => a.odo - b.odo);
  const segments = [];
  let anchor = null; // last full fill-up
  let litresSince = 0;
  let costSince = 0;
  for (const f of rows) {
    if (anchor && f.odo > anchor.odo) {
      litresSince += f.litres;
      costSince += f.cost || 0;
      if (f.full) {
        const miles = f.odo - anchor.odo;
        const gallons = litresSince / UK_GALLON;
        segments.push({
          to: f.date,
          toOdo: f.odo,
          miles,
          litres: litresSince,
          mpg: gallons > 0 ? miles / gallons : 0,
          costPerMile: costSince > 0 && miles > 0 ? costSince / miles : null,
        });
      }
    }
    if (f.full) {
      anchor = f;
      litresSince = 0;
      costSince = 0;
    }
  }
  const totalSpend = rows.reduce((s, f) => s + (f.cost || 0), 0);
  const totalLitres = rows.reduce((s, f) => s + f.litres, 0);
  const priced = rows.filter((f) => f.cost > 0);
  const lastPricePerLitre = priced.length ? (priced.at(-1).cost / priced.at(-1).litres) * 100 : null; // pence/L
  const mpgs = segments.map((s) => s.mpg).filter((m) => m > 0);
  return {
    segments,
    latestMpg: mpgs.at(-1) ?? null,
    avgMpg: mpgs.length ? mpgs.reduce((a, b) => a + b, 0) / mpgs.length : null,
    totalSpend,
    totalLitres,
    lastPricePerLitre,
  };
}

// ---------- renewals ----------
const DAY = 86400000;

/** Days until a date, with a severity band and friendly wording. */
export function countdown(dateISO, label, now = new Date()) {
  if (!dateISO) return null;
  const due = new Date(dateISO + 'T00:00:00');
  if (isNaN(due)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - today) / DAY);
  let level = 'ok';
  let text;
  if (days < 0) {
    level = 'urgent';
    text = `${label} overdue by ${-days} day${days === -1 ? '' : 's'}`;
  } else if (days === 0) {
    level = 'soon';
    text = `${label} due today`;
  } else if (days <= 14) {
    level = 'soon';
    text = `${label} due in ${days} day${days === 1 ? '' : 's'}`;
  } else if (days <= 30) {
    level = 'minor';
    text = `${label} due in ${days} days`;
  } else {
    text = `${label} due in ${days} days`;
  }
  return { days, level, text, label };
}

export const RENEWAL_TYPES = [
  { key: 'mot', label: 'MOT' },
  { key: 'tax', label: 'Road tax' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'service', label: 'Service' },
];

/** Build sorted countdowns from a { mot, tax, insurance, service } object of ISO dates. */
export function renewals(dates, now = new Date()) {
  return RENEWAL_TYPES.map((t) => ({ key: t.key, ...(countdown(dates[t.key], t.label, now) || {}) }))
    .filter((r) => r.text)
    .sort((a, b) => a.days - b.days);
}

// ---------- unified "coming up" ----------
// Pulls every dated item across the app into one list, soonest first. New
// sources (utilities, health, tax...) add their items here as they are built.
export function upcomingReminders({ renewalDates = {}, documents = [] }, now = new Date()) {
  const items = [];
  for (const r of renewals(renewalDates, now)) {
    items.push({ label: r.label, sub: 'Car', days: r.days, level: r.level, text: r.text });
  }
  for (const d of documents) {
    if (!d.expiry) continue;
    const cd = countdown(d.expiry, d.label, now);
    if (cd) items.push({ label: d.label, sub: d.category, days: cd.days, level: cd.level, text: cd.text });
  }
  return items.sort((a, b) => a.days - b.days);
}

// ---------- parking ----------
export function parkMapsUrl(spot) {
  if (!spot) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
}

export function timeAgo(iso, now = Date.now()) {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------- mileage (incl. business reclaim) ----------
// HMRC approved mileage rates (cars): 45p/mile up to 10,000 business miles in a
// tax year, 25p/mile after. A guide only — not tax advice.
export function mileageSummary(trips) {
  const business = trips.filter((t) => t.business);
  const businessMiles = business.reduce((s, t) => s + (t.miles || 0), 0);
  const totalMiles = trips.reduce((s, t) => s + (t.miles || 0), 0);
  const first10k = Math.min(businessMiles, 10000);
  const over = Math.max(0, businessMiles - 10000);
  const reclaim = first10k * 0.45 + over * 0.25;
  return { businessMiles, totalMiles, reclaim };
}

export function mileageExport(trips) {
  const lines = ['Date,Miles,Purpose,Business'];
  for (const t of [...trips].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const purpose = `"${(t.purpose || '').replace(/"/g, '""')}"`;
    lines.push([t.date, t.miles, purpose, t.business ? 'yes' : 'no'].join(','));
  }
  return lines.join('\n');
}
