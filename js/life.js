// Pure logic for the life-admin sections: UK tax estimates, subscriptions,
// health due-dates, meter usage. All figures are rough guides (England,
// 2025/26 thresholds) — not advice.

// ---------- tax estimators ----------
const PERSONAL_ALLOWANCE = 12570;
const BASIC_BAND = 37700; // taxable income taxed at 20%
const ADDITIONAL_THRESHOLD = 125140;

export function personalAllowance(income) {
  if (income <= 100000) return PERSONAL_ALLOWANCE;
  return Math.max(0, PERSONAL_ALLOWANCE - (income - 100000) / 2);
}

/** Rough income tax on a salary (England). */
export function incomeTax(income) {
  const pa = personalAllowance(income);
  const basicCeil = pa + BASIC_BAND;
  let tax = 0;
  if (income > pa) tax += (Math.min(income, basicCeil) - pa) * 0.2;
  if (income > basicCeil) tax += (Math.min(income, ADDITIONAL_THRESHOLD) - basicCeil) * 0.4;
  if (income > ADDITIONAL_THRESHOLD) tax += (income - ADDITIONAL_THRESHOLD) * 0.45;
  return Math.round(tax);
}

/** Rough employee National Insurance. */
export function employeeNI(income) {
  let ni = 0;
  if (income > 12570) ni += (Math.min(income, 50270) - 12570) * 0.08;
  if (income > 50270) ni += (income - 50270) * 0.02;
  return Math.round(ni);
}

/** Rough dividend tax, with dividends stacked on top of other income. */
export function dividendTax(otherIncome, dividends) {
  const taxable = Math.max(0, dividends - 500); // dividend allowance
  let pos = Math.max(otherIncome, PERSONAL_ALLOWANCE);
  let remaining = taxable;
  let tax = 0;
  const take = (ceil, rate) => {
    const amt = Math.min(remaining, Math.max(0, ceil - pos));
    tax += amt * rate;
    pos += amt;
    remaining -= amt;
  };
  take(50270, 0.0875);
  take(ADDITIONAL_THRESHOLD, 0.3375);
  take(Infinity, 0.3935);
  return Math.round(tax);
}

export function takeHome(income) {
  const tax = incomeTax(income);
  const ni = employeeNI(income);
  return { tax, ni, net: income - tax - ni };
}

// ---------- UK tax deadlines ----------
function nextOccurrence(month, day, now) {
  let year = now.getFullYear();
  const d = new Date(year, month, day);
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function taxDeadlines(now = new Date()) {
  return [
    { label: 'Self Assessment & tax payment', date: nextOccurrence(0, 31, now) }, // 31 Jan
    { label: 'Payment on account', date: nextOccurrence(6, 31, now) }, // 31 Jul
  ];
}

// ---------- subscriptions ----------
export function monthlyEquivalent(sub) {
  const c = sub.cost || 0;
  if (sub.cycle === 'yearly') return c / 12;
  if (sub.cycle === 'weekly') return (c * 52) / 12;
  return c; // monthly
}
export function subscriptionsTotal(subs) {
  const monthly = subs.reduce((s, x) => s + monthlyEquivalent(x), 0);
  return { monthly, yearly: monthly * 12 };
}

/** Combined recurring outgoings (subscriptions + utilities) for the money overview. */
export function moneyOverview(subs = [], utils = []) {
  const subItems = subs.map((s) => ({ name: s.name || 'Subscription', monthly: monthlyEquivalent(s), cat: 'Subscriptions', saving: 0 }));
  const utilItems = utils.map((u) => ({
    name: [u.provider, u.type].filter(Boolean).join(' ') || u.type || 'Utility',
    monthly: u.cost || 0,
    cat: 'Utilities',
    saving: u.recommendation && u.cost && u.recommendation.bestMonthly ? Math.max(0, u.cost - u.recommendation.bestMonthly) : 0,
  }));
  const items = [...subItems, ...utilItems].filter((i) => i.monthly > 0).sort((a, b) => b.monthly - a.monthly);
  const monthly = items.reduce((s, i) => s + i.monthly, 0);
  const byCat = {};
  for (const i of items) byCat[i.cat] = (byCat[i.cat] || 0) + i.monthly;
  const categories = Object.entries(byCat).map(([label, m]) => ({ label, monthly: m })).sort((a, b) => b.monthly - a.monthly);
  const savings = items.reduce((s, i) => s + (i.saving || 0), 0);
  return { monthly, yearly: monthly * 12, categories, items, savings };
}

// ---------- health ----------
/** Next-due date from a last date + interval in months. */
export function nextDue(lastISO, intervalMonths) {
  if (!lastISO || !intervalMonths) return null;
  const d = new Date(lastISO + 'T00:00:00');
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + Number(intervalMonths));
  return d.toISOString().slice(0, 10);
}

// ---------- meter readings ----------
/** Usage per day between the two most recent readings of a utility. */
export function meterUsage(readings) {
  const rows = [...readings].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length < 2) return null;
  const a = rows[rows.length - 2];
  const b = rows[rows.length - 1];
  const days = (new Date(b.date) - new Date(a.date)) / 86400000;
  if (days <= 0) return null;
  const used = b.reading - a.reading;
  return { used, days, perDay: used / days };
}
