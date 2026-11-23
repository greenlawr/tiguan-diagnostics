import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarTitles, sameEvent, groupEvents } from '../js/eventmatch.js';

test('similar titles: rewordings of the same thing match', () => {
  assert.ok(similarTitles('Bins out: blue-lidded bin & food waste caddy', '🗑️ Bin Reminder: Blue-lidded bin & food waste caddy'));
  assert.ok(similarTitles('Ivy Club dinner (Lawrence & folks)', 'Lawrence and Folks - Ivy Club Dinner  17:00'));
  assert.ok(similarTitles('Jess Christmas do', 'Jess Christmas ‘do'));
  assert.ok(similarTitles('Maddy bday party 1-4', 'Maddy bday party 1-4'));
});

test('similar titles: different things do not match', () => {
  assert.ok(!similarTitles('Dentist — Maddy', 'Dentist — Lawrence'));
  assert.ok(!similarTitles('School run', 'School play'));
  assert.ok(!similarTitles('Football training', 'Swimming'));
});

test('same event needs same day and time', () => {
  const a = { date: '2026-11-28', time: '15:30', title: 'Ivy Club dinner' };
  assert.ok(sameEvent(a, { ...a, title: 'Ivy Club Dinner 17:00' }));
  assert.ok(!sameEvent(a, { ...a, time: '19:00' }));
  assert.ok(!sameEvent(a, { ...a, date: '2026-11-29' }));
  assert.ok(!sameEvent(a, { ...a, virtual: true }));
});

test('an event in both calendars becomes one "Both" row; link copies fold into the calendar copy', () => {
  const rows = [
    { id: 'g1', src: 'c1', who: 'Lawrence', date: '2026-11-28', time: '', title: 'Maddy bday party 1-4' },
    { id: 'g2', src: 'c2', who: 'Jess', date: '2026-11-28', time: '', title: 'Maddy bday party 1-4' },
    { id: 'e9', date: '2026-11-26', time: '20:00', title: 'Bins out: blue-lidded bin & food waste caddy' },
    { id: 'g3', src: 'c1', who: 'Lawrence', date: '2026-11-26', time: '20:00', title: '🗑️ Bin Reminder: Blue-lidded bin & food waste caddy' },
    { id: 'g4', src: 'c2', who: 'Jess', date: '2026-11-26', time: '09:00', title: 'Jess WFH' },
  ];
  const out = groupEvents(rows);
  assert.equal(out.length, 3);
  const party = out.find((r) => /Maddy/.test(r.title));
  assert.equal(party.who, 'Both');
  assert.deepEqual(party.people.sort(), ['Jess', 'Lawrence']);
  const bins = out.find((r) => /Bin/.test(r.title));
  assert.equal(bins.id, 'g3', 'the calendar copy is kept');
  assert.equal(bins.who, 'Lawrence');
});
