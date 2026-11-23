import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImport, iso } from '../js/import.js';
import { mileageSummary, taxYearStart } from '../js/garage.js';

test('UK dates in Quick Import (no US reading, no time-zone shift)', () => {
  assert.equal(iso('05/03/2026'), '2026-03-05');
  assert.equal(iso('25/12/2026'), '2026-12-25');
  assert.equal(iso('1 June 2026'), '2026-06-01');
  assert.equal(iso('June 1st, 2026'), '2026-06-01');
  assert.equal(iso('2026-11-05'), '2026-11-05');
  assert.equal(iso('31/02/2026'), '');
  assert.equal(iso('soon'), '');
});

test('subscription billing words', () => {
  const r = parseImport('subscription: Gym | 120 | annual\nsubscription: A | 5 | per year\nsubscription: B | 2 | weekly\nsubscription: C | 9');
  assert.deepEqual(r.subscriptions.map((s) => s.cycle), ['yearly', 'yearly', 'weekly', 'monthly']);
});

test('business mileage counts the current tax year only', () => {
  const now = new Date(2026, 10, 23);
  assert.equal(taxYearStart(now), '2026-04-06');
  assert.equal(taxYearStart(new Date(2026, 3, 5)), '2025-04-06');
  const m = mileageSummary([{ date: '2026-01-10', miles: 9000, business: true }, { date: '2026-05-01', miles: 100, business: true }], now);
  assert.equal(m.businessMiles, 100);
});
