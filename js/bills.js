// Bills, contracts and insurance: the rules behind the nudges (pure, testable).
// UK guidance only — not advice.

export const BILL_TYPES = ['Energy', 'Electricity', 'Gas', 'Water', 'Broadband', 'Mobile', 'TV', 'Council tax', 'Other'];
export const BILL_ICON = { Energy: '⚡', Electricity: '⚡', Gas: '🔥', Water: '💧', Broadband: '🌐', Mobile: '📱', TV: '📺', 'TV / streaming': '📺', 'Council tax': '🏛️', Other: '🧾' };
export const CAN_SWITCH = new Set(['Energy', 'Electricity', 'Gas', 'Broadband', 'Mobile', 'TV', 'TV / streaming']);

export const COMPARE_LINKS = {
  Energy: [['Compare energy (MSE)', 'https://www.moneysavingexpert.com/utilities/']],
  Electricity: [['Compare energy (MSE)', 'https://www.moneysavingexpert.com/utilities/']],
  Gas: [['Compare energy (MSE)', 'https://www.moneysavingexpert.com/utilities/']],
  Broadband: [['Compare broadband (MSE)', 'https://www.moneysavingexpert.com/broadband/'], ['What speeds can we get? (Ofcom)', 'https://checker.ofcom.org.uk/']],
  Mobile: [['Compare mobile deals (MSE)', 'https://www.moneysavingexpert.com/mobiles/'], ['Coverage at home (Ofcom)', 'https://checker.ofcom.org.uk/']],
  TV: [['Compare TV & broadband (MSE)', 'https://www.moneysavingexpert.com/broadband/']],
  'TV / streaming': [['Compare TV & broadband (MSE)', 'https://www.moneysavingexpert.com/broadband/']],
  'Council tax': [['Check your band (GOV.UK)', 'https://www.gov.uk/council-tax-bands']],
};

const days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const iso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const ukDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * What to do about a bill's contract, if anything.
 * bill: { type, renewal (contract end), handset ('included'|'sim'|'separate'), cost }
 * Returns { level: 'urgent'|'soon'|'info', text } or null.
 */
export function contractNudge(bill, today) {
  const t = bill.type;
  if (!CAN_SWITCH.has(t) || !iso(bill.renewal)) return null;
  const d = days(today, bill.renewal);
  if (d < 0) {
    if (t === 'Mobile' && bill.handset === 'included') return { level: 'urgent', text: `Out of contract since ${ukDate(bill.renewal)} — the phone's paid off, so you're still paying for it. Switch to a SIM-only deal (often £8–£15 a month) or ask ${bill.provider || 'them'} for one.` };
    return { level: 'soon', text: `Out of contract since ${ukDate(bill.renewal)} — you're probably paying more than new customers. Haggle or switch.` };
  }
  if (d <= 60) {
    const what = t === 'Mobile' ? (bill.handset === 'included' ? "Don't just roll on — once the phone's paid off, SIM-only saves a lot." : 'Look at SIM-only deals or ask for a loyalty price.') : 'Best time to haggle or switch — you can usually move without exit fees in the last weeks.';
    return { level: d <= 30 ? 'soon' : 'info', text: `Contract ends ${ukDate(bill.renewal)} (${d} day${d === 1 ? '' : 's'}). ${what}` };
  }
  return null;
}

/** Price change against last year (insurance renewals, mid-contract rises). */
export function priceChange(now, before) {
  const a = Number(now), b = Number(before);
  if (!(a > 0) || !(b > 0)) return null;
  const diff = Math.round((a - b) * 100) / 100;
  const pct = Math.round(((a - b) / b) * 100);
  return { diff, pct, level: pct >= 10 ? 'urgent' : pct > 0 ? 'soon' : 'ok', text: pct > 0 ? `up ${pct}% on last year` : pct < 0 ? `down ${-pct}% on last year` : 'same as last year' };
}

/** Council tax: what each instalment is (10 or 12 a year) and the true monthly average. */
export function councilTax(annual, instalments = 10) {
  const a = Number(annual);
  if (!(a > 0)) return null;
  const n = Number(instalments) === 12 ? 12 : 10;
  return { instalment: Math.round((a / n) * 100) / 100, instalments: n, monthlyAverage: Math.round((a / 12) * 100) / 100 };
}

// ---------- insurance ----------
export const POLICY_KINDS = [
  ['home', 'Home & contents', '🏠'], ['buildings', 'Buildings', '🧱'], ['contents', 'Contents', '🛋️'], ['car', 'Car', '🚗'], ['pet', 'Pet', '🐾'],
  ['life', 'Life', '💚'], ['income', 'Income protection', '🛡️'], ['travel', 'Travel (annual)', '✈️'], ['boiler', 'Boiler / home emergency', '🔥'],
  ['gadget', 'Phone / gadget', '📱'], ['health', 'Private medical', '❤️'], ['other', 'Other', '📄'],
];
export const policyLabel = (k) => (POLICY_KINDS.find(([v]) => v === k) || POLICY_KINDS[POLICY_KINDS.length - 1])[1];
export const policyIcon = (k) => (POLICY_KINDS.find(([v]) => v === k) || POLICY_KINDS[POLICY_KINDS.length - 1])[2];
/** Guess the kind from free text (for moving older entries across). */
export function guessPolicyKind(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(car|motor|vehicle|tiguan)\b/.test(t)) return 'car';
  if (/\bpet|dog|cat\b/.test(t)) return 'pet';
  if (/travel|holiday/.test(t)) return 'travel';
  if (/\blife\b|critical illness/.test(t)) return 'life';
  if (/income protection/.test(t)) return 'income';
  if (/boiler|home ?care|home emergency|heating/.test(t)) return 'boiler';
  if (/building/.test(t)) return 'buildings';
  if (/contents/.test(t) && !/home/.test(t)) return 'contents';
  if (/home|house/.test(t)) return 'home';
  if (/phone|gadget|mobile/.test(t)) return 'gadget';
  if (/medical|bupa|vitality|health/.test(t)) return 'health';
  return 'other';
}
export const INSURANCE_COMPARE = {
  car: 'https://www.moneysavingexpert.com/insurance/car-insurance/', home: 'https://www.moneysavingexpert.com/insurance/home-insurance/',
  buildings: 'https://www.moneysavingexpert.com/insurance/home-insurance/', contents: 'https://www.moneysavingexpert.com/insurance/home-insurance/',
  pet: 'https://www.moneysavingexpert.com/insurance/pet-insurance/', travel: 'https://www.moneysavingexpert.com/insurance/travel-insurance/',
  life: 'https://www.moneysavingexpert.com/insurance/life-insurance/', boiler: 'https://www.moneysavingexpert.com/insurance/boiler-cover/',
};
/** A nudge for a policy near renewal (with price creep if we know last year's price). */
export function policyNudge(p, today) {
  if (!iso(p.renewal)) return null;
  const d = days(today, p.renewal);
  if (d > 45) return null;
  const pc = priceChange(p.premium, p.lastPremium);
  const tail = p.autoRenew ? " It renews automatically, so if you do nothing you'll pay their renewal price." : '';
  if (d < 0) return { level: 'urgent', text: `Renewal date passed (${ukDate(p.renewal)}) — check you're still covered.` };
  return { level: d <= 21 ? 'soon' : 'info', text: `Renews ${ukDate(p.renewal)}${pc && pc.pct > 0 ? `, ${pc.text}` : ''}. Get a couple of quotes before then.${tail}` };
}
