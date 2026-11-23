// Minimal iCalendar (.ics) reader for a Google Calendar "secret address" feed.
// Parses events and expands repeating ones into dated occurrences.
// Times come out as local wall-clock (the phone's time zone).

const pad = (n) => String(n).padStart(2, '0');
const DAY = 86400000;
const toNum = ({ y, m, d }) => Math.round(Date.UTC(y, m - 1, d) / DAY);
const fromNum = (n) => { const t = new Date(n * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekday = (n) => new Date(n * DAY).getUTCDay(); // 0 = Sunday
const numToISO = (n) => { const { y, m, d } = fromNum(n); return `${y}-${pad(m)}-${pad(d)}`; };
const isoToNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return toNum({ y, m, d }); };
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}
function unescapeText(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

/** "20261126T200000Z" | "20261126T200000" | "20261126" -> date parts (UTC converted to local). */
export function parseDT(value, params = {}) {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, , z] = m;
  if (hh === undefined || params.VALUE === 'DATE') return { y: +y, m: +mo, d: +d, allDay: true };
  if (z) {
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), hh: t.getHours(), mm: t.getMinutes(), allDay: false };
  }
  return { y: +y, m: +mo, d: +d, hh: +hh, mm: +mm, allDay: false };
}

export function parseICS(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...ps] = line.slice(0, i).split(';');
    const value = line.slice(i + 1);
    const params = {};
    for (const p of ps) { const [k, v = ''] = p.split('='); params[k.toUpperCase()] = v.replace(/"/g, ''); }
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.title = unescapeText(value); break;
      case 'LOCATION': cur.where = unescapeText(value); break;
      case 'STATUS': cur.status = value.trim().toUpperCase(); break;
      case 'DTSTART': cur.start = parseDT(value, params); break;
      case 'DTEND': cur.end = parseDT(value, params); break;
      case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((p) => { const [k, v = ''] = p.split('='); return [k.toUpperCase(), v]; })); break;
      case 'EXDATE': for (const v of value.split(',')) { const dt = parseDT(v, params); if (dt) cur.exdates.push(dt); } break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDT(value, params); break;
      default: break;
    }
  }
  return events;
}

const occKey = (dt) => `${toNum(dt)}${dt.allDay ? '' : `T${pad(dt.hh)}${pad(dt.mm)}`}`;

// Day numbers on which a repeating event occurs, from its start up to `limitN` (exclusive).
function* recur(e, limitN) {
  const r = e.rrule;
  const startN = toNum(e.start);
  const freq = (r.FREQ || '').toUpperCase();
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? parseDT(r.UNTIL) : null;
  const limit = Math.min(limitN, until ? toNum(until) + 1 : Infinity);
  let n = 0;
  let guard = 0;
  const byDay = (r.BYDAY || '').split(',').filter(Boolean);
  if (freq === 'DAILY') {
    for (let d = startN; d < limit && n < count && guard++ < 40000; d += interval) { n++; yield d; }
  } else if (freq === 'WEEKLY') {
    const days = byDay.length ? byDay.map((x) => DAYS[x.slice(-2)]) : [weekday(startN)];
    const monday = startN - ((weekday(startN) + 6) % 7);
    for (let w = monday; w < limit && n < count && guard++ < 10000; w += 7 * interval) {
      for (let k = 0; k < 7; k++) {
        const d = w + k;
        if (d < startN || !days.includes(weekday(d))) continue;
        if (d >= limit || n >= count) return;
        n++; yield d;
      }
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const s = e.start;
    const step = freq === 'MONTHLY' ? interval : 12 * interval;
    for (let i = 0; guard++ < 5000; i += step) {
      const total = s.y * 12 + (s.m - 1) + i;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const first = toNum({ y, m, d: 1 });
      if (first >= limit || n >= count) return;
      const last = toNum({ y, m: m + 1, d: 1 }) - 1;
      let cands = [];
      if (freq === 'MONTHLY' && byDay.length) {
        for (const spec of byDay) {
          const dow = DAYS[spec.slice(-2)];
          const nth = parseInt(spec.slice(0, -2), 10);
          if (!nth) { for (let d = first; d <= last; d++) if (weekday(d) === dow) cands.push(d); }
          else if (nth > 0) { const d = first + ((dow - weekday(first) + 7) % 7) + (nth - 1) * 7; if (d <= last) cands.push(d); }
          else { const d = last - ((weekday(last) - dow + 7) % 7) - (-nth - 1) * 7; if (d >= first) cands.push(d); }
        }
      } else {
        const days = freq === 'MONTHLY' && r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : [s.d];
        for (const dd of days) { const d = dd > 0 ? first + dd - 1 : last + dd + 1; if (d >= first && d <= last) cands.push(d); }
      }
      cands = [...new Set(cands)].sort((a, b) => a - b);
      for (const d of cands) {
        if (d < startN) continue;
        if (d >= limit || n >= count) return;
        n++; yield d;
      }
    }
  } else {
    yield startN; // unknown rule: just the first occurrence
  }
}

/**
 * Expand events into occurrences between `fromISO` and `fromISO + days` (exclusive).
 * @returns [{ uid, title, where, date: 'YYYY-MM-DD', time: 'HH:MM' | '' }] sorted
 */
export function expandEvents(events, fromISO, days) {
  const from = isoToNum(fromISO);
  const to = from + days;
  const overridden = new Map();
  for (const e of events) if (e.recurrenceId) {
    if (!overridden.has(e.uid)) overridden.set(e.uid, new Set());
    overridden.get(e.uid).add(occKey(e.recurrenceId));
  }
  const out = [];
  const emit = (e, start) => {
    const startN = toNum(start);
    let span = 1;
    if (start.allDay && e.end && e.end.allDay) span = Math.max(1, Math.min(14, toNum(e.end) - toNum(e.start)));
    for (let k = 0; k < span; k++) {
      const n = startN + k;
      if (n < from || n >= to) continue;
      out.push({ uid: e.uid || '', title: e.title || 'Event', where: e.where || '', date: numToISO(n), time: start.allDay ? '' : `${pad(start.hh)}:${pad(start.mm)}` });
    }
  };
  for (const e of events) {
    if (e.recurrenceId) { if (e.status !== 'CANCELLED') emit(e, e.start); continue; }
    if (e.status === 'CANCELLED') continue;
    if (!e.rrule) { emit(e, e.start); continue; }
    const skip = new Set([...e.exdates.map(occKey), ...(overridden.get(e.uid) || [])]);
    for (const d of recur(e, to)) {
      if (d + 14 < from) continue;
      const occ = { ...e.start, ...fromNum(d) };
      if (skip.has(occKey(occ))) continue;
      emit(e, occ);
    }
  }
  return out.sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')));
}
