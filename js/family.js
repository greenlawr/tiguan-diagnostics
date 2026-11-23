// Small helpers for the Family section: ages, birthdays and hiding numbers.
// Dates are 'YYYY-MM-DD' strings and are handled without time zones.

const parse = (iso) => { const [y, m, d] = String(iso || '').split('-').map(Number); return y && m && d ? { y, m, d } : null; };
const pad = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Age in whole years on `todayISO`, or null. */
export function ageOn(dobISO, todayISO) {
  const b = parse(dobISO), t = parse(todayISO);
  if (!b || !t) return null;
  let age = t.y - b.y;
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age--;
  return age < 0 ? null : age;
}

/** Friendly age: "3 months", "1 year", "7 years". */
export function ageText(dobISO, todayISO) {
  const b = parse(dobISO), t = parse(todayISO);
  if (!b || !t) return '';
  const years = ageOn(dobISO, todayISO);
  if (years === null) return '';
  if (years >= 2) return `${years} years`;
  let months = (t.y - b.y) * 12 + (t.m - b.m) - (t.d < b.d ? 1 : 0);
  if (months < 1) return 'newborn';
  return months < 24 ? `${months} month${months === 1 ? '' : 's'}` : `${years} years`;
}

/** Next birthday on or after today: { date, turning }. 29 Feb birthdays fall on 28 Feb in other years. */
export function nextBirthday(dobISO, todayISO) {
  const b = parse(dobISO), t = parse(todayISO);
  if (!b || !t) return null;
  for (const y of [t.y, t.y + 1]) {
    const date = `${y}-${pad(b.m)}-${pad(Math.min(b.d, daysInMonth(y, b.m)))}`;
    if (date >= todayISO && y >= b.y) return { date, turning: y - b.y };
  }
  return null;
}

/** Hide all but the last 3 characters: "485 777 3456" -> "••• ••• •456". */
export function mask(value) {
  const s = String(value || '');
  let keep = 3;
  const out = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (/[A-Za-z0-9]/.test(c) && keep > 0) { out.push(c); keep--; } else out.push(/[A-Za-z0-9]/.test(c) ? '•' : c);
  }
  return out.reverse().join('');
}

/** NHS numbers are 10 digits with a built-in check digit (modulus 11). */
export function nhsNumberValid(value) {
  const d = String(value || '').replace(/\s/g, '');
  if (!/^\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  const check = 11 - (sum % 11);
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === Number(d[9]);
}
