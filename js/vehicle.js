// "My car" details and MOT reminder.
//
// The official UK MOT-history and tax services need a government API key and
// cannot be called from a web page in the browser. So this app does NOT fetch
// that data itself: it stores the car's registration and MOT due date on the
// phone, shows a countdown, and links out to the free official gov.uk services
// where the owner sees the live data. Nothing is sent anywhere by the app.

const two = (n) => String(n).padStart(2, '0');
const ymd = (date) => `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;

/** Days until the MOT is due, with a severity level. Null when no date is set. */
export function motCountdown(dueISO, now = new Date()) {
  if (!dueISO) return null;
  const due = new Date(dueISO + 'T00:00:00');
  if (isNaN(due)) return null;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - startOfToday) / 86400000);
  let level = 'ok';
  let text;
  if (days < 0) {
    level = 'urgent';
    text = `MOT overdue by ${-days} day${days === -1 ? '' : 's'} — the car may not be legal to drive`;
  } else if (days === 0) {
    level = 'soon';
    text = 'MOT due today';
  } else if (days <= 14) {
    level = 'soon';
    text = `MOT due in ${days} day${days === 1 ? '' : 's'} — book it now`;
  } else if (days <= 30) {
    level = 'minor';
    text = `MOT due in ${days} days`;
  } else {
    text = `MOT due in ${days} days`;
  }
  return { days, level, text, due };
}

export const GOV_MOT_HISTORY = 'https://www.check-mot.service.gov.uk/';
export const GOV_TAX_CHECK = 'https://vehicleenquiry.service.gov.uk/';

/** A Google Calendar "create event" link for the MOT due date (an all-day reminder). */
export function calendarUrl(reg, dueISO) {
  const start = new Date(dueISO + 'T00:00:00');
  if (isNaN(start)) return null;
  const end = new Date(start.getTime() + 86400000);
  const title = `MOT due${reg ? ` – ${reg.toUpperCase()}` : ''}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${ymd(start)}/${ymd(end)}`,
    details: 'MOT test due. Book it in good time to avoid driving without a valid MOT.',
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

/** Light validation / tidy-up of a UK registration. Not strict — just trims and upper-cases. */
export const cleanReg = (reg) => (reg || '').toUpperCase().replace(/\s+/g, ' ').trim().slice(0, 10);
