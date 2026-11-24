// Pure logic for the life-admin sections: UK tax estimates, subscriptions,
// health due-dates, meter usage. All figures are rough guides (England,
// 2026/27; income tax and NI thresholds are frozen) — not advice.

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

/**
 * Rough dividend tax, with dividends stacked on top of other income.
 * Order of the stack: any unused Personal Allowance covers dividends at 0%,
 * then the £500 dividend allowance (0%, but it still uses up band space),
 * then the dividend rates. The allowance tapers above £100k.
 * Rates: 8.75% / 33.75% / 39.35% up to 2025/26; from 6 April 2026 the basic
 * and higher rates rose to 10.75% / 35.75% (Autumn Budget 2025).
 */
export function taxYearOf(date = new Date()) {
  const y = date.getFullYear();
  return date >= new Date(y, 3, 6) ? y : y - 1; // 2026 means 2026/27
}
export function dividendRates(taxYear = taxYearOf()) {
  return taxYear >= 2026 ? [0.1075, 0.3575, 0.3935] : [0.0875, 0.3375, 0.3935];
}
export function dividendTax(otherIncome, dividends, taxYear = taxYearOf()) {
  const [basicRate, higherRate, addRate] = dividendRates(taxYear);
  const pa = personalAllowance(otherIncome + dividends);
  const basicTop = pa + BASIC_BAND;
  let pos = otherIncome;
  let remaining = dividends;
  let tax = 0;
  const take = (ceil, rate) => {
    const amt = Math.min(remaining, Math.max(0, ceil - pos));
    tax += amt * rate;
    pos += amt;
    remaining -= amt;
  };
  take(pa, 0); // unused Personal Allowance
  const allowance = Math.min(remaining, 500);
  pos += allowance;
  remaining -= allowance;
  take(basicTop, basicRate);
  take(ADDITIONAL_THRESHOLD, higherRate);
  take(Infinity, addRate);
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

/** Who owes whom from shared, split, unsettled bills. net>0 = you're owed, net<0 = you owe. */
export function householdBalance(bills, myName) {
  let net = 0;
  let sharedTotal = 0;
  for (const b of bills) {
    if (b.deleted) continue;
    sharedTotal += b.amount || 0;
    if (b.settled || !b.split) continue;
    const half = (b.amount || 0) / 2;
    if (b.paidBy === myName) net += half;
    else net -= half;
  }
  return { net, sharedTotal };
}

/** Combined recurring outgoings (subscriptions + utilities) for the money overview. */
export function moneyOverview(subs = [], utils = [], policies = []) {
  const subItems = subs.map((s) => ({ name: s.name || 'Subscription', monthly: monthlyEquivalent(s), cat: 'Subscriptions', saving: 0 }));
  const utilItems = utils.map((u) => ({
    name: [u.provider, u.type].filter(Boolean).join(' ') || u.type || 'Utility',
    monthly: u.cost || 0,
    cat: 'Bills',
    saving: u.recommendation && u.cost && u.recommendation.bestMonthly ? Math.max(0, u.cost - u.recommendation.bestMonthly) : 0,
  }));
  const policyItems = policies.map((p) => ({ name: [p.insurer, 'insurance'].filter(Boolean).join(' ') || 'Insurance', monthly: (Number(p.premium) || 0) / 12, cat: 'Insurance', saving: 0 }));
  const items = [...subItems, ...utilItems, ...policyItems].filter((i) => i.monthly > 0).sort((a, b) => b.monthly - a.monthly);
  const monthly = items.reduce((s, i) => s + i.monthly, 0);
  const byCat = {};
  for (const i of items) byCat[i.cat] = (byCat[i.cat] || 0) + i.monthly;
  const categories = Object.entries(byCat).map(([label, m]) => ({ label, monthly: m })).sort((a, b) => b.monthly - a.monthly);
  const savings = items.reduce((s, i) => s + (i.saving || 0), 0);
  return { monthly, yearly: monthly * 12, categories, items, savings };
}

// ---------- health ----------
/** Next-due date from a last date + interval in months (calendar maths, no time zones). */
export function nextDue(lastISO, intervalMonths) {
  if (!lastISO || !intervalMonths) return null;
  const [y, m, d] = String(lastISO).split('-').map(Number);
  if (!y || !m || !d) return null;
  const total = y * 12 + (m - 1) + Number(intervalMonths);
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`;
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
