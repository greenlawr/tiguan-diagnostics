import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICS, expandEvents } from '../js/ical.js';

const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const show = (occ) => occ.map((o) => `${o.date} ${o.time || 'all'} ${o.title}`);

test('single timed and all-day events, with folding and escapes', () => {
  const text = cal(
    ev(['UID:a', 'DTSTART;TZID=Europe/London:20261128T153000', 'DTEND;TZID=Europe/London:20261128T203000', 'SUMMARY:Ivy Club dinner\\, Lawrence & folks', 'LOCATION:The Ivy', ' Club']),
    ev(['UID:b', 'DTSTART;VALUE=DATE:20261130', 'DTEND;VALUE=DATE:20261201', 'SUMMARY:Occasional Day (no school)']),
  );
  const occ = expandEvents(parseICS(text), '2026-11-23', 14);
  assert.deepEqual(show(occ), ['2026-11-28 15:30 Ivy Club dinner, Lawrence & folks', '2026-11-30 all Occasional Day (no school)']);
  assert.equal(occ[0].where, 'The IvyClub'); // folded line joined per RFC 5545
});

test('window excludes past and far-future events', () => {
  const text = cal(ev(['UID:a', 'DTSTART;VALUE=DATE:20261101', 'SUMMARY:Past']), ev(['UID:b', 'DTSTART;VALUE=DATE:20270301', 'SUMMARY:Later']));
  assert.equal(expandEvents(parseICS(text), '2026-11-23', 14).length, 0);
});

test('multi-day all-day event shows on each day in the window', () => {
  const text = cal(ev(['UID:a', 'DTSTART;VALUE=DATE:20261222', 'DTEND;VALUE=DATE:20261225', 'SUMMARY:Away']));
  assert.deepEqual(show(expandEvents(parseICS(text), '2026-11-23', 60)), ['2026-12-22 all Away', '2026-12-23 all Away', '2026-12-24 all Away']);
});

test('weekly repeat with BYDAY, a skipped date and a moved occurrence', () => {
  const text = cal(
    ev(['UID:bins', 'DTSTART;TZID=Europe/London:20261008T200000', 'RRULE:FREQ=WEEKLY;BYDAY=TH', 'EXDATE;TZID=Europe/London:20261203T200000', 'SUMMARY:Bins out']),
    ev(['UID:bins', 'RECURRENCE-ID;TZID=Europe/London:20261210T200000', 'DTSTART;TZID=Europe/London:20261209T190000', 'SUMMARY:Bins out (early)']),
  );
  assert.deepEqual(show(expandEvents(parseICS(text), '2026-11-23', 21)), [
    '2026-11-26 20:00 Bins out',
    '2026-12-09 19:00 Bins out (early)',
  ]);
});

test('fortnightly with COUNT, and UNTIL', () => {
  const text = cal(
    ev(['UID:f', 'DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'SUMMARY:Swim']),
    ev(['UID:u', 'DTSTART;TZID=Europe/London:20261123T090000', 'RRULE:FREQ=DAILY;UNTIL=20261125T235959Z', 'SUMMARY:Course']),
  );
  assert.deepEqual(show(expandEvents(parseICS(text), '2026-11-01', 60)), [
    '2026-11-01 all Swim', '2026-11-15 all Swim',
    '2026-11-23 09:00 Course', '2026-11-24 09:00 Course', '2026-11-25 09:00 Course',
    '2026-11-29 all Swim',
  ]);
});

test('monthly nth weekday and yearly birthday', () => {
  const text = cal(
    ev(['UID:m', 'DTSTART;TZID=Europe/London:20260106T183000', 'RRULE:FREQ=MONTHLY;BYDAY=1TU', 'SUMMARY:Book club']),
    ev(['UID:l', 'DTSTART;VALUE=DATE:20260130', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:Payday']),
    ev(['UID:y', 'DTSTART;VALUE=DATE:20101207', 'RRULE:FREQ=YEARLY', 'SUMMARY:Maddy birthday']),
  );
  assert.deepEqual(show(expandEvents(parseICS(text), '2026-11-23', 30)), [
    '2026-11-27 all Payday', '2026-12-01 18:30 Book club', '2026-12-07 all Maddy birthday',
  ]);
});

test('cancelled events and cancelled single occurrences are dropped', () => {
  const text = cal(
    ev(['UID:c', 'DTSTART;VALUE=DATE:20261126', 'STATUS:CANCELLED', 'SUMMARY:Off']),
    ev(['UID:w', 'DTSTART;TZID=Europe/London:20261124T100000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Walk']),
    ev(['UID:w', 'RECURRENCE-ID;TZID=Europe/London:20261125T100000', 'DTSTART;TZID=Europe/London:20261125T100000', 'STATUS:CANCELLED', 'SUMMARY:Walk']),
  );
  assert.deepEqual(show(expandEvents(parseICS(text), '2026-11-23', 7)), ['2026-11-24 10:00 Walk', '2026-11-26 10:00 Walk']);
});
