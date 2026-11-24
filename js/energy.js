// Energy comparison, worked out on the phone from your own usage. Nothing here
// leaves the phone: the server only supplies public tariff lists.
// All rates are Direct Debit, including VAT: unit rates in pence per kWh,
// standing charges in pence per day.

// Ofgem price cap (GB average, Direct Debit). Every supplier's standard variable
// tariff sits at or near this. Updated each quarter (announced ~5 weeks ahead).
export const PRICE_CAPS = [
  { from: '2026-07-01', to: '2026-09-30', label: 'Jul–Sep 2026', elec: { unit: 26.11, standing: 57.19 }, gas: { unit: 7.33, standing: 29.04 } },
  { from: '2026-10-01', to: '2026-12-31', label: 'Oct–Dec 2026', elec: { unit: 26.32, standing: 54.83 }, gas: { unit: 7.97, standing: 29.68 } },
];
// Ofgem's typical household (used only if there's nothing better).
export const TYPICAL = { elec: 2500, gas: 9500 };

export const REGIONS = [
  ['_A', 'East of England'], ['_B', 'East Midlands'], ['_C', 'London'], ['_D', 'Merseyside & North Wales'], ['_E', 'West Midlands'],
  ['_F', 'North East'], ['_G', 'North West'], ['_H', 'Southern'], ['_J', 'South East'], ['_K', 'South Wales'], ['_L', 'South West'],
  ['_M', 'Yorkshire'], ['_N', 'South Scotland'], ['_P', 'North Scotland'],
];

/** The cap in force on a date (or the latest one we know). */
export function capFor(dateISO) {
  return PRICE_CAPS.find((c) => c.from <= dateISO && dateISO <= c.to) || PRICE_CAPS[PRICE_CAPS.length - 1];
}
/** Next quarter's cap, if it's been announced and added. */
export function nextCap(dateISO) {
  return PRICE_CAPS.find((c) => c.from > dateISO) || null;
}

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
/** £ per year for one fuel. rates: { unit p/kWh, standing p/day } */
export function fuelCost(rates, kwh) {
  if (!rates || num(rates.unit) == null) return null;
  return (num(kwh) || 0) * num(rates.unit) / 100 + 365 * (num(rates.standing) || 0) / 100;
}
/** £ per year for a tariff that may have electricity, gas or both. Null if a fuel you use is missing. */
export function tariffCost(t, usage) {
  let total = 0;
  for (const fuel of ['elec', 'gas']) {
    if (!usage[fuel]) continue;
    const c = fuelCost(t[fuel], usage[fuel]);
    if (c == null) return null;
    total += c;
  }
  return Math.round(total * 100) / 100;
}

// Gas meters read in cubic metres; bills charge in kWh. (Older imperial meters
// read in hundreds of cubic feet — multiply those by 2.83 first.)
export const gasM3ToKwh = (m3, calorific = 39.5) => (m3 * 1.02264 * calorific) / 3.6;

/**
 * Yearly use from meter readings: [{date, reading}] in kWh (electricity) or m³ (gas).
 * Uses the longest span available. Under ~10 months it's an estimate, because
 * winter and summer use differ a lot.
 */
export function yearlyFromReadings(readings, fuel) {
  const rows = (readings || []).filter((r) => r.date && Number.isFinite(Number(r.reading))).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length < 2) return null;
  const first = rows[0], last = rows[rows.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  const used = Number(last.reading) - Number(first.reading);
  if (days < 14 || used <= 0) return null;
  let perYear = (used / days) * 365;
  if (fuel === 'gas') perYear = gasM3ToKwh(perYear);
  return { kwh: Math.round(perYear), days: Math.round(days), rough: days < 300 };
}

/**
 * Compare your current deal with other options, cheapest first.
 * options: [{ name, supplier?, elec?, gas?, source }]
 */
export function compareTariffs(current, options, usage) {
  const now = tariffCost(current, usage);
  return options
    .map((o) => {
      const cost = tariffCost(o, usage);
      return { ...o, cost, saving: cost != null && now != null ? Math.round((now - cost) * 100) / 100 : null };
    })
    .filter((o) => o.cost != null)
    .sort((a, b) => a.cost - b.cost);
}
